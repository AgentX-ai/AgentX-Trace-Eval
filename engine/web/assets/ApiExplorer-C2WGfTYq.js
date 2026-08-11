const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/rapidoc-min-C1PPp2ho.js","assets/index-BX7IFddg.js","assets/index-D1Df0prk.css"])))=>i.map(i=>d[i]);
import{a5 as H,fJ as L,a2 as O,fK as B,b_ as I,af as D,r as w,u as M,bx as F,j as a,f as X,k as T,cW as G,cX as J,cY as $,fs as j,bq as z,ah as Y,I as V}from"./index-BX7IFddg.js";import{L as W}from"./useMarkdownComponents-CFB-8_RB.js";const Q=`${O.replace("/api/v1","")}/download-openapi`,K=async()=>(await L.get(Q)).data,Z=()=>H({queryKey:["openApi"],queryFn:K}),ee=["/api/v1/access/agents/{id}/conversations","/api/v1/access/agents/{id}/conversations/{cid}","/api/v1/access/conversations/{id}/messagesse","/api/v1/access/conversations/{id}/message","/api/v1/access/conversations/{id}/update-context"],N=o=>{const e={...o,paths:{}};for(const t of ee)o.paths[t]&&(e.paths[t]=o.paths[t]);return e},q=(o,e)=>{if(!e)return o;const t=JSON.parse(JSON.stringify(o)),n=["/api/v1/access/agents/{id}/conversations","/api/v1/access/agents/{id}/conversations/{cid}"];for(const c of n)if(t.paths[c])for(const r in t.paths[c]){t.paths[c][r].parameters&&t.paths[c][r].parameters.forEach(p=>{p.in==="path"&&c.includes("agents/{id}")&&(p.example=e)});const s=t.paths[c][r].description,d=`

**Note:** The example agent ID used is the currently selected agent.`;typeof s=="string"?t.paths[c][r].description=s+d:t.paths[c][r].description=d.trimStart()}return t},A=(o,e,t)=>{if(!e)return o;const n=JSON.parse(JSON.stringify(o)),c=["/api/v1/access/conversations/{id}/messagesse","/api/v1/access/conversations/{id}/message","/api/v1/access/conversations/{id}/update-context","/api/v1/access/agents/{id}/conversations/{cid}"];for(const r of c)if(n.paths[r])for(const s in n.paths[r]){n.paths[r][s].parameters&&n.paths[r][s].parameters.forEach(g=>{g.in==="path"&&(r.includes("conversations/{id}")||g.name==="cid")&&(g.example=e)});const d=n.paths[r][s].description,h=t?`

**Note:** The example conversation ID used is the most recently open conversation.`:`

**Note:** The example conversation ID used is the currently open conversation (right panel).`;typeof d=="string"?n.paths[r][s].description=d+h:n.paths[r][s].description=h.trimStart()}return n},_=o=>{var t,n;const e=JSON.parse(JSON.stringify(o));return(n=(t=e.components)==null?void 0:t.securitySchemes)!=null&&n.ApiKeyAuth&&delete e.components.securitySchemes.ApiKeyAuth,e.security&&(e.security=e.security.filter(c=>!c.ApiKeyAuth)),e},E=o=>{const e=JSON.parse(JSON.stringify(o)),t=O.replace("/api/v1","");return e.servers=[{url:t}],e};function P(o,e){var n,c;const t=JSON.parse(JSON.stringify(o));for(const r in t.paths)for(const s in t.paths[r]){const d=t.paths[r][s];try{const p=te(r,d),h=`${((c=(n=t.servers)==null?void 0:n[0])==null?void 0:c.url)||"https://api.example.com"}${p}`,g=oe(d),b=[{lang:"shell (cURL)",source:ne(h,s.toUpperCase(),g,e)},{lang:"Python (requests)",source:ae(h,s.toUpperCase(),g,e)},{lang:"Node.js (Fetch)",source:re(h,s.toUpperCase(),g,e)},{lang:"Node.js (Axios)",source:se(h,s.toUpperCase(),g,e)},{lang:"Go (native)",source:ie(h,s.toUpperCase(),g,e)},{lang:"Ruby (Net::HTTP)",source:ce(h,s.toUpperCase(),g,e)},{lang:"Java (OkHttp)",source:pe(h,s.toUpperCase(),g,e)},{lang:"PHP (cURL)",source:le(h,s.toUpperCase(),g,e)}];d["x-code-samples"]=b.filter(y=>y.source)}catch(p){console.error(`Failed to generate code samples for ${s.toUpperCase()} ${r}:`,p)}}return t}function te(o,e){let t=o;if(e.parameters){for(const n of e.parameters)if(n.in==="path"&&n.example){const c=`{${n.name}}`;t=t.replace(c,String(n.example))}}return t}function oe(o){var t,n;const e=(n=(t=o.requestBody)==null?void 0:t.content)==null?void 0:n["application/json"];return e!=null&&e.example?JSON.stringify(e.example,null,2):null}function ne(o,e,t,n){return t?`curl -X ${e} "${o}" \\
  -H 'x-api-key: ${n}' \\
  -H 'Content-Type: application/json' \\
  -d '${t}'`:`curl -X ${e} "${o}" \\
  -H 'x-api-key: ${n}'`}function ae(o,e,t,n){return t?`import requests

response = requests.${e.toLowerCase()}("${o}",
  headers={"x-api-key": "${n}", "Content-Type": "application/json"},
  json=${t}
)
print(response.json())`:`import requests

response = requests.${e.toLowerCase()}("${o}",
  headers={"x-api-key": "${n}"}
)
print(response.json())`}function re(o,e,t,n){return t?`const fetch = require('node-fetch');

const response = await fetch('${o}', {
  method: '${e}',
  headers: {
    'x-api-key': '${n}',
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(${t})
});
const data = await response.json();
console.log(data);`:`const fetch = require('node-fetch');

const response = await fetch('${o}', {
  method: '${e}',
  headers: {
    'x-api-key': '${n}'
  }
});
const data = await response.json();
console.log(data);`}function se(o,e,t,n){return t?`const axios = require('axios');

const response = await axios.${e.toLowerCase()}('${o}', ${t}, {
  headers: {
    'x-api-key': '${n}',
    'Content-Type': 'application/json'
  }
});
console.log(response.data);`:`const axios = require('axios');

const response = await axios.${e.toLowerCase()}('${o}', {
  headers: {
    'x-api-key': '${n}'
  }
});
console.log(response.data);`}function ie(o,e,t,n){return t?`package main

import (
  "fmt"
  "net/http"
  "bytes"
  "io/ioutil"
)

func main() {
  reqBody := []byte(${t})
  req, _ := http.NewRequest("${e}", "${o}", bytes.NewBuffer(reqBody))
  req.Header.Set("x-api-key", "${n}")
  req.Header.Set("Content-Type", "application/json")

  client := &http.Client{}
  resp, err := client.Do(req)
  if err != nil {
    fmt.Println(err)
    return
  }
  defer resp.Body.Close()

  bodyBytes, _ := ioutil.ReadAll(resp.Body)
  fmt.Println(string(bodyBytes))
}`:`package main

import (
  "fmt"
  "net/http"
  "io/ioutil"
)

func main() {
  req, _ := http.NewRequest("${e}", "${o}", nil)
  req.Header.Set("x-api-key", "${n}")

  client := &http.Client{}
  resp, err := client.Do(req)
  if err != nil {
    fmt.Println(err)
    return
  }
  defer resp.Body.Close()

  bodyBytes, _ := ioutil.ReadAll(resp.Body)
  fmt.Println(string(bodyBytes))
}`}function ce(o,e,t,n){const c=e.charAt(0)+e.slice(1).toLowerCase();return t?`require 'net/http'
require 'uri'
require 'json'

uri = URI.parse("${o}")
request = Net::HTTP::${c}.new(uri)
request["x-api-key"] = "${n}"
request["Content-Type"] = "application/json"
request.body = ${t}

response = Net::HTTP.start(uri.hostname, uri.port) do |http|
  http.request(request)
end

puts response.body`:`require 'net/http'
require 'uri'

uri = URI.parse("${o}")
request = Net::HTTP::${c}.new(uri)
request["x-api-key"] = "${n}"

response = Net::HTTP.start(uri.hostname, uri.port) do |http|
  http.request(request)
end

puts response.body`}function pe(o,e,t,n){return t?`OkHttpClient client = new OkHttpClient();
MediaType mediaType = MediaType.get("application/json");
RequestBody requestBody = RequestBody.create(${t}, mediaType);

Request request = new Request.Builder()
  .url("${o}")
  .method("${e}", requestBody)
  .addHeader("x-api-key", "${n}")
  .addHeader("Content-Type", "application/json")
  .build();

Response response = client.newCall(request).execute();
System.out.println(response.body().string());`:`OkHttpClient client = new OkHttpClient();

Request request = new Request.Builder()
  .url("${o}")
  .method("${e}", null)
  .addHeader("x-api-key", "${n}")
  .build();

Response response = client.newCall(request).execute();
System.out.println(response.body().string());`}function le(o,e,t,n){return t?`$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, "${o}");
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, "${e}");
curl_setopt($ch, CURLOPT_POSTFIELDS, ${t});
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, array("x-api-key: ${n}", "Content-Type: application/json"));
$response = curl_exec($ch);
curl_close($ch);
echo $response;`:`$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, "${o}");
curl_setopt($ch, CURLOPT_CUSTOMREQUEST, "${e}");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, array("x-api-key: ${n}"));
$response = curl_exec($ch);
curl_close($ch);
echo $response;`}function de(o){const{titleColor:e="black",borderColor:t="transparent",backgroundColor:n="transparent",borderColorHover:c="transparent",backgroundColorHover:r="transparent",headerBorderColorExpanded:s="transparent",bodyBorderColorExpanded:d="transparent",backgroundColorExpanded:p="transparent"}=o||{},l=()=>{const m=document.querySelector("rapi-doc");if(!(m!=null&&m.shadowRoot))return!1;const f=m.shadowRoot.querySelector("div.view-mode-request");return f?(f.setAttribute("style","display: block !important; min-height: auto !important; flex-direction: initial !important; overflow: visible !important;"),!0):!1},h=()=>{const m=document.querySelector("rapi-doc");if(!(m!=null&&m.shadowRoot)||m.shadowRoot.querySelector("#custom-endpoint-head-styles"))return;const f=document.createElement("style");f.id="custom-endpoint-head-styles",f.textContent=`
      /* --------- */
      /* Container */
      /* --------- */

      .main-content {
        padding-top: 16px !important;
        padding-bottom: 12px !important;
        padding-left: 2px !important;
        padding-right: 2px !important;
      }

      /* Header */

      #api-description, .section-tag-body > div > p, #api-title {
        font-weight: 700 !important;
      }

      #api-title {
        color: ${e} !important;
        font-size: 24px !important;
      }

      #api-title span {
        display: none !important;
      }

      #api-description {
        display:none;
        padding-top: 2px !important;
        margin-bottom: -12px !important;
      }

      .section-tag-header {
        display: none;
      }

      #operations-top + div {
        visibility: hidden;
      }

      /* ---------------------- */
      /* Endpoint list: general */
      /* ---------------------- */

      .endpoint-head.get, .endpoint-head.post, .endpoint-head.put,
      .endpoint-head.delete, .endpoint-head.patch, .endpoint-head.options,
      .endpoint-head.head, .endpoint-head.connect, .endpoint-head.trace {
        background-color: ${n} !important;
        border: 1px solid ${t} !important;
        box-shadow: none !important;
        color: inherit !important;
        margin-top: 8px !important;
        margin-bottom: 8px !important;
        padding-top: 8px !important;
        padding-bottom: 8px !important;
      }

      .method.get, .method.post, .method.put, .method.delete, .method.patch {
        color: white !important;
        margin-right: 8px !important;
      }

      .method.get {
        background-color: var(--blue) !important;
      }

      .method.post {
        background-color: var(--green) !important;
      }

      .method.put {
        background-color: var(--orange) !important;
      }

      .method.delete {
        background-color: var(--red) !important;
      }

      .method.patch {
        background-color: var(--purple) !important;
      }

      /* ------------------------ */
      /* Endpoint list - expanded */
      /* ------------------------ */

      .param-name {
        margin: 12px !important;
        color: ${e} !important;
      }

      .summary .title {
        font-weight: 600 !important
      }

      .endpoint-head.get.expanded, .endpoint-head.post.expanded, .endpoint-head.put.expanded,
      .endpoint-head.delete.expanded, .endpoint-head.patch.expanded, .endpoint-head.options.expanded,
      .endpoint-head.head.expanded, .endpoint-head.connect.expanded, .endpoint-head.trace.expanded {
        background-color: ${p} !important;
        border: 1px solid ${s} !important;
        box-shadow: none !important;
        color: inherit !important;
        margin-top: 8px !important;
        margin-bottom: 8px !important;
        padding-top: 8px !important;
        padding-bottom: 8px !important;
      }

      .endpoint-head .method.get,
      .endpoint-head .method.post,
      .endpoint-head .method.put,
      .endpoint-head .method.delete,
      .endpoint-head .method.patch,
      .endpoint-head .method.options,
      .endpoint-head .method.head,
      .endpoint-head .method.connect,
      .endpoint-head .method.trace {
        border: 1x solid ${t} !important;
      }

      .m-endpoint .endpoint-body.get,
      .m-endpoint .endpoint-body.post,
      .m-endpoint .endpoint-body.put,
      .m-endpoint .endpoint-body.delete,
      .m-endpoint .endpoint-body.patch,
      .m-endpoint .endpoint-body.options,
      .m-endpoint .endpoint-body.head,
      .m-endpoint .endpoint-body.connect,
      .m-endpoint .endpoint-body.trace {
        border-top: 0px solid transparent !important;
        border-left: 0px solid transparent !important;
        border-right: 0px solid transparent !important;
        border-bottom: 1px solid ${d} !important;
        box-shadow: none !important;
      }

      /* -------------------- */
      /* Endpoint list: hover */
      /* -------------------- */

      .endpoint-head.get:hover, .endpoint-head.post:hover, .endpoint-head.put:hover,
      .endpoint-head.delete:hover, .endpoint-head.patch:hover, .endpoint-head.options:hover,
      .endpoint-head.head:hover, .endpoint-head.connect:hover, .endpoint-head.trace:hover {
        background-color: ${r} !important;
        border: 1px solid ${c} !important;
        box-shadow: none !important;
        color: inherit !important;
      }
    `,m.shadowRoot.appendChild(f)};function g(){const m=document.querySelector("rapi-doc");if(!(m!=null&&m.shadowRoot))return;m.shadowRoot.querySelectorAll("api-request").forEach(u=>{const i=u.shadowRoot;if(i&&!i.querySelector("#custom-param-style")){const x=document.createElement("style");x.id="custom-param-style",x.textContent=`
          .param-name {
            margin-top: 13px !important;
          }
          .param-type {
            margin-top: 3px !important;
            padding-bottom: 11px !important;
          }
        `,i.appendChild(x)}})}const b=()=>{l(),h(),g()};b();const y=new MutationObserver(()=>{b()}),k=document.querySelector("rapi-doc");return k!=null&&k.shadowRoot&&y.observe(k.shadowRoot,{childList:!0,subtree:!0}),y}const he="/assets/python-logo-only-BdUMPFa5.svg",ue="data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='utf-8'?%3e%3c!--%20Uploaded%20to:%20SVG%20Repo,%20www.svgrepo.com,%20Generator:%20SVG%20Repo%20Mixer%20Tools%20--%3e%3csvg%20width='800px'%20height='800px'%20viewBox='0%200%20256%20256'%20xmlns='http://www.w3.org/2000/svg'%20preserveAspectRatio='xMinYMin%20meet'%3e%3cpath%20d='M0%200h256v256H0V0z'%20fill='%23F7DF1E'/%3e%3cpath%20d='M67.312%20213.932l19.59-11.856c3.78%206.701%207.218%2012.371%2015.465%2012.371%207.905%200%2012.89-3.092%2012.89-15.12v-81.798h24.057v82.138c0%2024.917-14.606%2036.259-35.916%2036.259-19.245%200-30.416-9.967-36.087-21.996M152.381%20211.354l19.588-11.341c5.157%208.421%2011.859%2014.607%2023.715%2014.607%209.969%200%2016.325-4.984%2016.325-11.858%200-8.248-6.53-11.17-17.528-15.98l-6.013-2.58c-17.357-7.387-28.87-16.667-28.87-36.257%200-18.044%2013.747-31.792%2035.228-31.792%2015.294%200%2026.292%205.328%2034.196%2019.247L210.29%20147.43c-4.125-7.389-8.591-10.31-15.465-10.31-7.046%200-11.514%204.468-11.514%2010.31%200%207.217%204.468%2010.14%2014.778%2014.608l6.014%202.577c20.45%208.765%2031.963%2017.7%2031.963%2037.804%200%2021.654-17.012%2033.51-39.867%2033.51-22.339%200-36.774-10.654-43.819-24.574'/%3e%3c/svg%3e",me="data:image/svg+xml,%3c?xml%20version='1.0'%20encoding='UTF-8'%20standalone='no'?%3e%3c!--%20Uploaded%20to:%20SVG%20Repo,%20www.svgrepo.com,%20Generator:%20SVG%20Repo%20Mixer%20Tools%20--%3e%3csvg%20width='800px'%20height='800px'%20viewBox='0%200%2024%2024'%20xmlns:rdf='http://www.w3.org/1999/02/22-rdf-syntax-ns%23'%20xmlns='http://www.w3.org/2000/svg'%20version='1.1'%20xmlns:cc='http://creativecommons.org/ns%23'%20xmlns:dc='http://purl.org/dc/elements/1.1/'%3e%3cg%20transform='translate(0%20-1028.4)'%3e%3cpath%20d='m3%201030.4c-1.1046%200-2%200.9-2%202v7%202%207c0%201.1%200.8954%202%202%202h9%209c1.105%200%202-0.9%202-2v-7-2-7c0-1.1-0.895-2-2-2h-9-9z'%20fill='%232c3e50'/%3e%3cpath%20d='m3%202c-1.1046%200-2%200.8954-2%202v3%203%201%201%201%203%203c0%201.105%200.8954%202%202%202h9%209c1.105%200%202-0.895%202-2v-3-4-2-3-3c0-1.1046-0.895-2-2-2h-9-9z'%20transform='translate(0%201028.4)'%20fill='%2334495e'/%3e%3cpath%20d='m4%205.125v1.125l3%201.75-3%201.75v1.125l5-2.875-5-2.875zm5%204.875v1h5v-1h-5z'%20transform='translate(0%201028.4)'%20fill='%23ecf0f1'/%3e%3c/g%3e%3c/svg%3e";let U=!1;const ge=async()=>{U||(await z(()=>import("./rapidoc-min-C1PPp2ho.js").then(o=>o.r),__vite__mapDeps([0,1,2])),U=!0)},C="#7844D3",fe="https://docs.agentx.so/docs/getting-started",xe="pip install --upgrade agentx-python",ye=`from agentx import AgentX

# Initialize the client
client = AgentX(api_key="YOUR_API_KEY")

# Get the list of agents your account has
agents = client.list_agents()
print(f"You have {len(agents)} agents")

# Pick an agent and start chatting with it
if agents:
    agent = agents[0]
    conversation = agent.new_conversation()
    response = conversation.chat("Hello! What can you help me with?")
    print(response)`,ve=`from agentx import AgentX

client = AgentX(api_key="<your api key here>")

# Get the list of workforces your account has
workforces = client.list_workforces()
print(workforces)

# Pick a workforce and get more information about it
workforce = workforces[0]  # or any specific workforce
print(f"Workforce: {workforce.name}")
print(f"Manager: {workforce.manager.name}")
print(f"Agents: {[agent.name for agent in workforce.agents]}")

# List all existing conversations for the workforce
conversations = workforce.list_conversations()
print(conversations)

# Create a new conversation session with the workforce
conversation = workforce.new_conversation()

# Chat with the workforce in a conversation session and stream the response
response = workforce.chat_stream(conversation.id, "How can you help me with this project?")
for chunk in response:
    if chunk.text:
        print(chunk.text, end="")
    if chunk.cot:
        print(f" [COT: {chunk.cot}]")
`,we="npm install @agentx-ai/agentx-js@latest -g",be=`import { AgentX } from "@agentx-ai/agentx-js";

const client = new AgentX(apiKey: "<your api key here>");

// Get the list of agents your account has
const agents = await client.listAgents();
console.log(agents);

// Pick an agent and get more information about it
const myAgent = await client.getAgent(id: "<agent id here>");

// Get the list of conversation sessions from this agent
const existingConversations = await myAgent.listConversations();
console.log(existingConversations);

// Get the list of history messages from a conversation session
const lastConversation = existingConversations[existingConversations.length - 1];
const msgs = await lastConversation.listMessages();
console.log(msgs);

// Pick a conversation session and get more information about it
const aConversation = await myAgent.getConversation(id: "<conversation id here>");

// Chat in the conversation session
const response = await aConversation.chat("Hello, what is your name?");

// Chat with the agent in a conversation session and stream the response
const stream = aConversation.chatStream("Hello, what is your name?");
for await (const chunk of stream) {
  console.log(chunk);
}
`,ke=`import { AgentX } from "@agentx-ai/agentx-js";

const client = new AgentX(apiKey: "<your api key here>");

// Get the list of workforces your account has
const workforces = await AgentX.listWorkforces();
console.log(workforces);

// Pick a workforce and get more information about it
const workforce = workforces[0]; // or any specific workforce
console.log(workforce.name);
console.log(workforce.manager.name);

// Create a new conversation session with the workforce
const conversation = await workforce.newConversation();

// Chat with the workforce in a conversation session and stream the response
const stream = workforce.chatStream(
  conversation.id,
  "How can you help me with this project?"
);
for await (const chunk of stream) {
  if (chunk.text) {
    process.stdout.write(chunk.text);
  }
  if (chunk.cot) {
    console.log(chunk.cot);
  }
}
`,je=()=>{const{data:o,isLoading:e,isPending:t,isError:n}=Z(),c=B(),[r]=c.getValues(["_id","publishedToCommunity"]),{conversationId:s}=I(),{isMobile:d}=D(),p=w.useRef(null),{user:l}=M(),[h,g]=w.useState("python"),[,b]=F(),[y,k]=w.useState(!1);w.useEffect(()=>{ge().then(()=>{k(!0)})},[]),w.useEffect(()=>{if(p.current&&o&&y){const u=setTimeout(()=>{if(p.current){let i=N(o);i=E(i),i=q(i,r),i=A(i,s,d),i=_(i),i=P(i,(l==null?void 0:l.apiKey)||"YOUR_API_KEY");try{p.current.loadSpec(i)}catch(x){console.warn("Failed to load rapi-doc spec, retrying...",x),setTimeout(()=>{p.current&&p.current.loadSpec(i)},500)}}},100);return()=>clearTimeout(u)}},[o,r,s,d,l==null?void 0:l.apiKey,y]),w.useEffect(()=>{if(!y)return;const u=()=>{if(document.querySelector("rapi-doc")&&p.current){const S=de({titleColor:C,borderColorHover:C,headerBorderColorExpanded:C,bodyBorderColorExpanded:C});return()=>{S.disconnect()}}return null};let i=u();if(!i){const x=setTimeout(()=>{i=u()},200);return()=>{clearTimeout(x),i&&i()}}return i},[h,y]),w.useEffect(()=>{if(h==="curl"&&o&&y){const u=()=>{if(document.querySelector("rapi-doc")&&p.current){let v=N(o);v=E(v),v=q(v,r),v=A(v,s,d),v=_(v),v=P(v,(l==null?void 0:l.apiKey)||"YOUR_API_KEY"),p.current.loadSpec(v)}};u();const i=setTimeout(u,100),x=setTimeout(u,500),R=setTimeout(u,1e3);return()=>{clearTimeout(i),clearTimeout(x),clearTimeout(R)}}},[h,o,r,s,d,l==null?void 0:l.apiKey,y]);const m=u=>{b(u)};if(e||t)return a.jsx(X,{className:"flex items-center justify-center pt-4"});if(n)return a.jsx("div",{className:"p-10",children:a.jsx("p",{children:"There was an error when retrieving API documentation."})});const f=({code:u,language:i,title:x})=>a.jsxs("div",{className:"group relative rounded-xl border border-neutral-100 bg-white p-6 shadow-sm transition-all duration-200 hover:border-neutral-200 hover:shadow-md",children:[a.jsxs("div",{className:"mb-2 flex items-center justify-between",children:[a.jsx("span",{className:"text-sm font-bold text-neutral-600",children:x}),a.jsx(Y,{variant:"tertiary",size:"small",icon:a.jsx(V.CopyChat,{className:"h-4 w-4"}),onClick:()=>m(u),className:"opacity-0 transition-opacity duration-200 group-hover:opacity-100"})]}),a.jsx("div",{className:"relative",children:a.jsx(W,{language:i,customStyle:{background:"transparent",fontSize:"12px",lineHeight:"1.5",margin:0,padding:0,fontFamily:"'SF Mono', 'Monaco', 'Inconsolata', 'Roboto Mono', monospace"},children:u})})]});return a.jsx("div",{className:T("space-y-8 px-6 py-8",d&&"px-0 py-0"),children:a.jsxs(G,{value:h,onValueChange:u=>g(u),className:"w-full rounded-xl",children:[a.jsxs(J,{className:"grid w-full grid-cols-3 gap-2 overflow-x-auto bg-neutral-100 p-1",children:[a.jsxs($,{value:"python",className:"flex min-w-0 flex-1 items-center justify-center gap-2 text-neutral-600 data-[state=active]:text-neutral-750",children:[a.jsx("img",{src:he,alt:"Python",className:"w-3"}),"Python"]}),a.jsxs($,{value:"javascript",className:"flex min-w-0 flex-1 items-center justify-center gap-2 text-neutral-600 data-[state=active]:text-neutral-750",children:[a.jsx("img",{src:ue,alt:"JavaScript",className:"w-3"}),"JavaScript"]}),a.jsxs($,{value:"curl",className:"flex min-w-0 flex-1 items-center justify-center gap-2 text-neutral-600 data-[state=active]:text-neutral-750",children:[a.jsx("img",{src:me,alt:"cURL",className:"w-3"}),"cURL"]})]}),a.jsx(j,{value:"python",className:"rounded-md bg-neutral-100 p-6",children:a.jsxs("div",{className:"space-y-8",children:[a.jsx("a",{href:"https://github.com/AgentX-ai/agentx-python",target:"_blank",rel:"noreferrer",className:"inline-block",children:a.jsx("img",{src:"https://img.shields.io/github/stars/AgentX-ai/agentx-python?style=social",alt:"github-python"})}),a.jsx("div",{className:"space-y-4",children:a.jsx(f,{code:xe,language:"bash",title:"Installation"})}),a.jsx("div",{className:"space-y-4",children:a.jsx(f,{code:ye,language:"python",title:"Usage Example"})}),a.jsx("div",{className:"space-y-4",children:a.jsx(f,{code:ve,language:"python",title:"Workforce Example"})})]})}),a.jsx(j,{value:"javascript",className:"rounded-md bg-neutral-100 p-6",children:a.jsxs("div",{className:"space-y-8",children:[a.jsx("a",{href:"https://github.com/AgentX-ai/agentx-js",target:"_blank",rel:"noreferrer",className:"inline-block",children:a.jsx("img",{src:"https://img.shields.io/github/stars/AgentX-ai/agentx-js?style=social",alt:"github-js"})}),a.jsx("div",{className:"space-y-4",children:a.jsx(f,{code:we,language:"bash",title:"Installation"})}),a.jsx("div",{className:"space-y-4",children:a.jsx(f,{code:be,language:"javascript",title:"Usage Example"})}),a.jsx("div",{className:"space-y-4",children:a.jsx(f,{code:ke,language:"javascript",title:"Workforce Example"})})]})}),a.jsx(j,{value:"curl",className:"rounded-md bg-neutral-100 p-6",children:a.jsxs("div",{className:"space-y-8",children:[a.jsx("a",{href:"https://docs.agentx.so/docs/getting-started?app=api-explorer",target:"_blank",rel:"noreferrer",className:"mb-1 inline-block",children:"📚 AgentX API Full Documentation"}),a.jsxs("div",{className:"group relative rounded-xl border border-neutral-100 bg-white p-6 shadow-sm transition-all duration-200 hover:border-neutral-200 hover:shadow-md",children:[a.jsx("h3",{className:"flex items-center gap-3 text-lg font-semibold text-neutral-900",children:"Interactive API Documentation"}),a.jsx("p",{className:"text-base leading-relaxed text-neutral-600",children:"Explore all available endpoints and test them directly in your browser with our interactive API documentation."})]}),a.jsx("div",{className:"rapidoc-container overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-xl",style:{height:"calc(100vh - 450px)",paddingRight:"2px",width:"100%"},children:a.jsx("rapi-doc",{"regular-font":"'Inter', sans-serif","mono-font":"'Menlo', monospace","bg-color":"#ffffff","primary-color":C,"allow-authentication":"false","allow-server-selection":"false","allow-spec-file-load":"false","allow-spec-url-load":"false","allow-try":"false","api-key-location":"header","api-key-name":"x-api-key","api-key-value":(l==null?void 0:l.apiKey)||"","code-samples":"true","collapse-path":"true","default-schema-tab":"schema","default-theme":"light",ref:p,"render-style":"view","show-header":"false","show-method-in-nav-bar":"as-colored-block",theme:"light",style:{overflowY:"auto !important"},children:a.jsx("div",{slot:"footer",className:T("mx-6 my-6 text-base",d&&"text-base"),children:a.jsx("a",{href:fe,target:"_blank",rel:"noreferrer",className:"font-medium text-primary-400 hover:underline",children:"View full documentation →"})})})})]})})]})})};export{je as ApiExplorer};
