---
name: Bug report
about: Something behaves differently than documented
labels: bug
---

**What happened, and what you expected instead**

**Smallest reproduction you have**
<!-- A curl call against a local engine, or an SDK snippet. -->

**Environment**
- Engine version or commit:
- How it is running: released binary / Docker / `yarn dev` from source
- Database: SQLite (default) or Postgres
- `AGENTX_AUTH`: disabled (default) or enabled

**Engine log around the failure**
<!-- Each request logs one structured line with a reqId, echoed in the X-Request-Id response
     header, so a failing browser call can be matched to its log line. Please scrub API keys. -->
