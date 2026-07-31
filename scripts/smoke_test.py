#!/usr/bin/env python3
"""
End-to-end smoke test for a running agentx-server instance, using the real, public
AgentX-Python SDK (`pip install agentx-python`), not a local checkout of it. Exercises
Trace, Evaluate, and Monitor against real HTTP calls, the same way any external SDK user
would.

Requires OPENAI_API_KEY (Evaluate's judge scoring, Monitor's semantic pattern detector) to
be set. Run via scripts/smoke-test.sh, which starts and stops agentx-server around this.

Usage:
    AGENTX_API_BASE_URL=http://localhost:4700/api/v1 \\
    AGENTX_API_KEY=<printed by agentx-server> \\
    python3 scripts/smoke_test.py
"""

import json
import os
import sys
import time
import urllib.request

from agentx import AgentX
from agentx.evaluations.models import EvaluationCase, EvaluationSubject


def check(label: str, condition: bool) -> None:
    status = "OK" if condition else "FAIL"
    print(f"  [{status}] {label}")
    if not condition:
        raise SystemExit(f"Smoke test failed: {label}")


def main() -> None:
    base_url = os.environ.get("AGENTX_API_BASE_URL")
    api_key = os.environ.get("AGENTX_API_KEY")
    if not base_url or not api_key:
        raise SystemExit("AGENTX_API_BASE_URL and AGENTX_API_KEY must be set (see agentx-server's startup output)")

    client = AgentX(api_key=api_key, base_url=base_url)

    print("Trace")
    with client.tracer.trace("smoke-test-agent", sync=True) as span:
        span.input = "ping"
        span.output = "pong"
    check("trace_id returned", bool(span.trace_id))

    print("Evaluate")
    dataset = (
        client.evaluations.datasets.builder(name="smoke-test dataset")
        .add_case(query="What is 2+2?", expected_results="4")
        .publish()
    )
    check("dataset created", bool(dataset.id))

    def answer(case: EvaluationCase) -> str:
        return "4"

    # The public execute()/finalize() path (not the private _client methods): builds cases from
    # the dataset, calls `answer` for each, submits results in batches, same as a real user's
    # evaluation script would do.
    ctx = client.evaluations.run(
        dataset.id, EvaluationSubject(kind="custom_agent", display_name="smoke-test-agent")
    ).execute(answer)
    ctx.finalize()

    # ctx.average_rating (public) needs liveStatistics on the finalize response, which self-host
    # doesn't compute yet (see engine/src/routes/evaluations.ts's scope note); GET /runs/:id
    # (also not yet SDK-public, no list_runs()/get_run() beyond the internal client) is what this
    # engine actually returns the average on, so that's what this test checks against instead.
    info = client.evaluations._client.get_run(ctx._run.run_id)
    check("run finalized", info["status"] == "completed")
    check("result scored", info["resultCount"] == 1)
    check("correct answer scored highly", info["averageRating"] is not None and info["averageRating"] >= 8)

    print("Monitor")
    with client.tracer.trace("smoke-test-agent", monitor=True) as span2:
        span2.input = "do the thing"
        span2.output = "done, but a tool failed"
        span2.tool_calls = [
            {"name": "lookup_thing", "input": "x", "output": "error: timeout", "latency_ms": 50, "success": False}
        ]

    signal = None
    for _ in range(10):
        time.sleep(1)
        signals = client.monitor.signals.list(limit=20)
        signal = next((s for s in signals if s.pattern_key.startswith("agent-tool-failure")), None)
        if signal:
            break
    check("tool-failure signal detected", signal is not None)

    pattern = client.monitor.patterns.builder(
        name="smoke-test refund mention",
        detector_kind="contains",
        include_terms=["refund"],
        severity="high",
    ).publish()
    check("custom pattern created", bool(pattern.id))

    with client.tracer.trace("smoke-test-agent", monitor=True) as span3:
        span3.input = "can I get my money back?"
        span3.output = "Sure, I have processed your refund."

    custom_signal = None
    for _ in range(10):
        time.sleep(1)
        signals = client.monitor.signals.list(limit=20)
        custom_signal = next((s for s in signals if s.pattern_key == pattern.key), None)
        if custom_signal:
            break
    check("custom pattern signal detected", custom_signal is not None)

    profile = client.monitor.profile.get("smoke-test-agent")
    print("  (profile before override:", profile, ")")
    client.monitor.profile.update("smoke-test-agent", threshold_overrides={"latencyMs": 500})
    profile2 = client.monitor.profile.get("smoke-test-agent")
    check("profile threshold override persisted", profile2.threshold_overrides.get("latencyMs") == 500)

    # These aren't part of the SDK's public surface (they're what the AgentX-web-front dashboard
    # itself calls in self-host mode, see engine/src/routes/agentMonitoringDashboard.ts and
    # ingest.ts's paginated GET /traces), so hit them directly rather than through `client`.
    print("Dashboard (AgentX-web-front self-host routes)")
    engine_root = base_url[: -len("/api/v1")] if base_url.endswith("/api/v1") else base_url
    auth_headers = {"x-api-key": api_key}

    def get_json(path: str, headers: dict | None = None):
        req = urllib.request.Request(f"{engine_root}{path}", headers=headers or {})
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())

    bootstrap = get_json("/api/v1/dev/bootstrap")
    check("bootstrap endpoint returns this instance's api key", bootstrap.get("apiKey") == api_key)

    traces_resp = get_json("/api/v1/ingest/traces?limit=20", headers=auth_headers)
    check(
        "traces response has ProductionTracesResponse envelope",
        {"traces", "hasNextPage", "nextCursor"}.issubset(traces_resp.keys()),
    )
    check(
        "this run's traces appear in the dashboard trace list",
        any(t.get("name") == "smoke-test-agent" for t in traces_resp["traces"]),
    )

    signals_resp = get_json("/api/v1/agent-monitoring/signals", headers=auth_headers)
    check("signals response has envelope", "signals" in signals_resp)
    check(
        "tool-failure signal visible on the dashboard route",
        any(s.get("patternKey") == signal.pattern_key for s in signals_resp["signals"]),
    )

    patterns_resp = get_json("/api/v1/agent-monitoring/patterns", headers=auth_headers)
    check("patterns response has envelope", "patterns" in patterns_resp)
    check("built-in patterns present", any(p.get("source") == "builtIn" for p in patterns_resp["patterns"]))
    check("custom pattern visible on the dashboard route", any(p.get("key") == pattern.key for p in patterns_resp["patterns"]))

    with urllib.request.urlopen(f"{engine_root}/governance?tab=observe", timeout=10) as resp:
        html = resp.read().decode()
    check("SPA index.html served for a client-side route", '<div id="root">' in html)

    print("\nAll checks passed.")


if __name__ == "__main__":
    main()
