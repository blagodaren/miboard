# MIBoard feature guide

[Русский](FEATURES.ru.md) · [English](FEATURES.en.md) · [README](../README.en.md)

## Connection and server profiles

MIBoard connects directly to the API of your mihomo core. The built dashboard can be served by the core itself, with no application server:

```yaml
external-controller: 127.0.0.1:9090
secret: "replace-with-a-long-random-secret"
external-ui: ui
external-ui-name: miboard
external-ui-url: "https://github.com/blagodaren/miboard/releases/download/v0.1.5/dist.zip"
```

Open `http://127.0.0.1:9090/ui/miboard/`. For access from other devices, bind the controller to its trusted LAN interface and restrict access with a firewall. Replace the archive name with `dist-cdn-fonts.zip` for the CDN-font build. A versioned URL pins a release; `/releases/latest/download/dist.zip` follows the latest stable version.

The `#/setup` page manages server names, API URLs and secrets. Saving a profile does not contact the server; **Connect** starts a connection. Editing a saved profile does not switch the active connection. The server link at the bottom of the sidebar and **Settings → Connection and core** open this page. Older saved connections are migrated automatically. Profiles and secrets stay in this browser's localStorage, separately for each site origin.

Deep links accept `#/?secret=...` and the zashboard-compatible `#/setup?hostname=...&port=...&secret=...` format. The dashboard removes credentials from its address after reading them. Treat such URLs as credentials and do not share or publish them.

For embedding (for example in a router web UI iframe where the profile sets the mode), `hideMode=1` hides the rule / global / direct switch: `http://<host>:9090/ui/miboard/?hideMode=1#/setup?hostname=...`. It removes the switch from the sidebar, the mobile header and **Settings → Connection and core**. The flag is read on page load; put it in `?query` rather than only in `#/...?query` so it survives a reload inside the frame. It only hides the control: the core API still accepts mode changes.

Separate hosting needs CORS on the core. For a local development server:

```yaml
external-controller-cors:
  allow-origins:
    - "http://localhost:5173"
    - "http://127.0.0.1:5173"
  allow-private-network: true
```

For [GitHub Pages](https://blagodaren.github.io/miboard/), allow `https://blagodaren.github.io` instead. The hosted page serves only the interface; it does not relay API requests. HTTPS pages should connect to an HTTPS API with a trusted certificate, using WSS for WebSocket streams. CORS does not bypass mixed-content restrictions. Browser permission may also be required to access a local network. If HTTPS is unavailable, open the core's own `/ui/` directly. The [GitHub Pages guide](../GITHUB_PAGES.md) is currently in Russian.

## Settings and data capture

Settings are split into five categories:

| Category | Controls |
| --- | --- |
| Appearance | Theme, language, proxy card size and group height |
| Connection and core | Server, routing mode, TUN/LAN, ports, core status and Prizrak-Core |
| Proxies | Latency settings and subscription warnings |
| Data | Live updates, connection journal, settings sync, import and export |
| App and maintenance | Installation, updates, caches, configuration and core restart |

Categories appear in a sidebar on wide screens and a select control on narrow screens. Switching categories preserves unsaved fields and previews. Links such as `#/settings?category=proxies` survive reloads and support browser back/forward navigation.

**Data → Live updates** offers continuous capture, the default, or economy mode. Economy mode suspends traffic, connection and memory streams while the browser tab is hidden, then resumes them when it becomes visible. Navigating between MIBoard pages does not stop capture. A notice marks gaps: connections that existed entirely during a pause are unknown to the dashboard. Surviving connections may include bytes transferred during the gap.

Telemetry reconnects after 15 seconds without data or 10 seconds without completing a connection. The last snapshot remains visible while reconnecting. Quiet logs are not treated as stalled telemetry. Connection speeds use the actual interval between snapshots; the first frame after a gap establishes a new baseline.

## App installation and updates

**Settings → App and maintenance** shows the MIBoard version, update state and offline readiness. The same controls are available on the server setup screen. Use the install button when offered by the browser, or its **Install app / Add to Home Screen** menu. On iPhone and iPad, installation uses the Share menu.

Installation and service workers require **HTTPS or localhost**. An ordinary `http://192.168.1.1:9090/ui/` deployment still works as a dashboard but does not gain the offline cache. Installing the app does not bypass CORS or HTTPS/HTTP restrictions.

After a successful cache save, the shell, saved server list and app settings can open offline. Live metrics, DNS checks and core commands still require a reachable API. The worker caches only built static files: HTML, JavaScript, CSS, local fonts, icons, GeoDB and licenses. It does not cache API responses, WebSockets, authorized requests or URLs with secrets. Server profiles and the local connection journal keep their separate storage. The CDN build falls back to system fonts when its CDN is unavailable. Service workers are disabled in `npm run dev`; test them using a production build or Vite preview.

Update checks compare two independent sources:

- `version.json` at the current dashboard URL, for a newer deployment build;
- the latest stable `blagodaren/miboard` release through the public GitHub API.

Automatic checks run on startup, return to the tab, network recovery and hourly while visible and online. They are limited to one per hour; successful GitHub results are cached for up to six hours. **Check for updates** requests fresh data manually. Core API data and secrets are not sent to either update service.

A new deployment build is downloaded and verified before it is offered. **Update and reload** applies it explicitly. After every tab closes, the browser may activate a prepared worker for the next launch. A broken or partially deployed build does not replace the working cache. The current and previous static generations are retained to support already open tabs.

A release notification does not update your own mihomo UI files. Replace them with the new archive or refresh the configured `external-ui-url`. Once your dashboard URL serves the new build, the app can apply it. Packaging validates relative manifest paths, PNG dimensions and integrity, worker/version consistency and every precache file hash in both archives.

## Overview

`#/overview` combines six metrics, a download/upload chart and top domains, outbound proxies and regions. Rankings retain closed connections within the current dashboard session and can sort by traffic or connection count. Total download/upload uses core counters; rankings use observations since the panel connected.

The chart keeps up to 24 hours of observations in the current tab, with 30-minute, 1-hour and 24-hour ranges. Reloading or reconnecting starts fresh history; gaps add no invented traffic. Regions use core destination metadata and local GeoIP, with an explicit unknown category. Overview does not request external GeoIP or DNS lookups.

Tests: `npm run test:overview`; with Vite running, `npm run test:overview:ui`.

## Devices

`#/devices` groups active connections by source IP. The flow shows **device → outbound node → domain or destination IP**. Shared nodes merge; edge width represents traffic or connection count. Large graphs aggregate remaining nodes under **Other** without losing their totals.

Selecting a device filters its destinations and details: download/upload, current speeds, TCP/UDP, processes, rules, inbounds and destination addresses. Search covers IP, local name, domain and process. Updates can be paused. Local names are stored separately for each server in this browser; an empty name removes the label.

In the active view, closed connections disappear. Historical ranges use the journal described below. IPv4 and IPv6 addresses of one physical device may appear separately. IP addresses do not identify a MAC, device model or OS. No extra server, LAN scan or external identity service is used.

Tests: `npm run test:devices`; with Vite running, `npm run test:devices:ui`.

## Proxies and providers

`#/proxies` has **Groups** and **Providers** tabs. `#/proxies?tab=providers` opens providers directly; navigation preserves filters and open groups and supports browser history.

Groups occupy two or three columns on wide screens. Node cards show protocol and latency, including provider nodes. **Settings → Appearance** offers large or compact cards and compact, tall or unlimited group lists. Long compact/tall lists scroll inside each group on wide screens; narrow screens keep natural height. Preferences apply immediately and persist in the browser.

Each group sorts nodes by configuration order, latency, name or protocol, with either direction. Preferences are per server and group. Unmeasured or failed nodes follow measured nodes. Manual Compatible nodes, nested groups, DIRECT and REJECT remain at the start in their original order; HTTP/File/Inline-provider nodes are sorted even when also included in `/proxies`.

**Apply node to all** selects the current group's exact selected entry in other groups of the current server, including collapsed, search-hidden and GLOBAL groups. It can copy a nested group name. Automatic groups, missing members and cyclic choices are skipped; other group sorting remains unchanged. A notification explains changes, skips and errors. Repeated actions are blocked until the operation finishes.

Notifications last eight seconds; hover, keyboard focus and a hidden tab pause dismissal. They can also be closed manually. Tests: `npm run test:proxy-sort`, `npm run test:proxy-sort:ui`, `npm run test:proxy-selection` and `npm run test:proxy-selection:ui`.

Provider cards show source, node counts and states, refresh time and reported subscription usage, remaining allowance and expiration. Their node tables support search, protocol filters, sorting and pages of 50 rows. Missing tests are marked untested, and missing limits are not inferred. Refresh succeeds only after metadata is fetched again. Provider health checks use the core's provider configuration and do not change the dashboard's latency settings. Leaving the tab stops waiting, although the core may finish an already started operation.

**Proxy stability** runs ten sequential HTTP checks of a selected leaf node using the configured URL and timeout. It shows median, p95, min/max, individual measurements and failures. This is a short manual series, not continuous monitoring or packet-loss measurement. Cancellation preserves finished results; an unfinished request is not counted as a failure.

Tests: `npm run test:stability`, `npm run test:providers` and `npm run test:providers:ui`.

### Latency checks

Without independent testing, **Test all** covers all leaf proxies, including hidden groups and provider nodes, at up to five concurrent checks. Built-in DIRECT, REJECT and other service types are excluded. With independent testing, it checks all nonempty non-GLOBAL groups by default, at up to three groups concurrently; the leaf-check limit remains five. Search and collapsed groups do not limit the run.

**Groups for bulk testing** selects a subset. Regular mode checks the union of its leaf nodes; independent mode checks each selected group with its own URL. Selection is per server, while manual group checks remain available. Same-name nodes from different providers are separate targets. When a group's member name cannot identify its provider, the core resolves group checks; choose the provider explicitly for individual diagnostics.

Each group shows a latency distribution across unique nodes: low, medium, high and no response/measurement. Search does not change the denominator. During a check the bar becomes progress. Failed nodes show a neutral dash, rather than a misleading high-latency result. Clicking latency rechecks only that node without selecting it. Group icons come from core metadata and fall back to the shared icon when unavailable. Tests: `npm run test:proxy-actions`.

**Settings → Proxies → Latency** chooses who schedules checks. The core mode submits one group request. The panel mode schedules individual API requests for Selector, LoadBalance and Smart groups, at up to five concurrent leaf checks; other types, including URLTest and Fallback, remain core-managed. Testing a pinned group in panel mode unpins it first. In both modes, the core performs the network measurement. Provider nodes use their provider API.

Defaults are panel mode, `https://www.gstatic.com/generate_204` and a 5000 ms timeout. Saved older preferences remain until reset. The allowed configured timeout is 1–32767 ms. Individual checks use it directly; bulk leaf tests cap it at 2000 ms, while core group tests use at least 5000 ms. These are HTTP proxy checks, not ICMP pings. Yellow/red thresholds persist in this browser.

Independent mode uses the group's configured URL when present, with its separate `extra[url]` history. Otherwise the shared URL and selected leaf history apply. Automatic URLTest groups may use their own configured URL even when a shared URL is supplied. Cards and sorting read the same history; different URLs remain separate. A nested group's result does not overwrite its selected leaf's independent measurement, and late group responses cannot replace a newer individual result.

Panel mode deduplicates the same node/URL/timeout within a bulk run, including IPv6. A new manual run sends new requests. Core-managed checks run group members in parallel; panel mode provides the five-request concurrency limit for large groups.

**IPv6 test** tries `https://ipv6.google.com/generate_204` before the primary check. A panel queue slot performs both requests in sequence; the IPv6 leaf timeout is always 2000 ms. Core mode performs the IPv6 group request, then the primary group request, with the group timeout. IPv6 results are separate and never replace primary latency. Nested groups resolve to selected leaves; cycles and missing selections do not imply IPv6 success. Automatic group results reflect the core's own URL behavior.

`unified-delay` comes from the core: enabled means a repeated check excludes the handshake; disabled includes connection establishment. The panel does not recalculate it. Missing status is shown as unknown. Scheduling behavior was cross-checked against [zashboard](https://github.com/Zephyruso/zashboard/blob/9e77e239b76a717a75ae73cd608f139a83f4c9f8/src/assembly/proxies/latency.ts).

Tests: `npm run test:latency` and `npm run test:latency:ui`.

## Prizrak-Core

[Prizrak-Core](https://core.prizrak.app/api/) capabilities are detected from `/configs` fields or Smart groups. Standard mihomo continues without these controls.

- **Connection and core → Prizrak-Core** shows LightGBM auto-update, its interval and model URL; the model update action runs through the core.
- Smart history can be cleared for every configuration or one filename without its extension, with confirmation.
- Expanded Smart groups show reported LightGBM/collector settings, sample share, ASN preference, latency tolerance and policy priority. Node weights are core scores from 0–100 with usage frequency, not selection probabilities.
- Switching a Smart connection's node marks the current node blocked for that site and closes the connection. A new connection lets the core choose again; another usable node may not exist.

Smart/LightGBM settings are read-only in this API: PATCH `/configs` does not accept them. Edit YAML and reload configuration to change them. A collector size is shown only when positive because some core versions always report zero.

Tests: `npm run test:backends` and `npm run test:prizrak`. For the manual PowerShell fixture, set `$env:PRIZRAK='1'` before `npm run mock`.

## Geography

`#/geography` maps destination countries using Equal Earth. Switch connection count/traffic, select a country to inspect hosts or pause updates. Country cards show total/download/upload and connection counts; their own switch controls ranking. Shares use identified countries. Six cards show initially; **Show all** reveals the rest. Card and map selection stay linked.

The wheel zooms around the pointer; dragging pans. Buttons zoom from 1× to 8× and reset the world. Keyboard controls: `+`/`−`, arrows and `0`/`Home`; an optional pan pad supports tapping. Repeated WebSocket frames do not inflate counts, and closed connections disappear from the active view.

Resolution order is core `metadata.destinationGeoIP`, then public `destinationIP` in local DB-IP Country Lite, then DNS through the connected core's `/dns/query` and that local database. IPv4 and IPv6 are supported. Private, service and fake-IP ranges are not geolocated. A missing/fake IP with a hostname triggers A and, if needed, AAAA; TTL-based caching and a four-request concurrency limit apply. Real private destination addresses do not trigger DNS. Unresolved entries remain unknown.

Proxy location, `remoteDestination` and domain suffixes are not destination geolocation evidence. DNS-derived countries are labeled estimates of the core's current DNS answer, which can differ from an address resolved by an exit proxy. Active traffic sums each currently open connection's lifetime download/upload, not all historical requests.

Map data and GeoDB are local; external map/IP lookup services are not called. The country database loads on demand, is about 845 KiB and needs no runtime dependency. The shipped DB-IP Country Lite snapshot is November 2026, under [CC BY 4.0](../public/geodb/NOTICE.md). Required attribution appears on the map. `public/geodb/manifest.json` records the original CSV URL, SHA-256, release month and snapshot date. GeoIP estimates a server's country, not an anycast node's proven physical location.

Update with `npm run update:geodb -- YYYY-MM`, rebuild and reload. Natural Earth outlines are [public domain](../src/lib/data/NOTICE.md); regenerate with `npm run generate:map` (network access is needed only for generation). Tests: `npm run test:geography`; with Vite running, `npm run test:geography:ui`.

### Database comparison

The [comparison report](../reports/geodb-comparison-2026-11-08.html) uses one DNS snapshot for both databases, IPv4/IPv6 results, control data-center references and a separate Discord anycast case. On 20 control IPs in ten countries, DB-IP matched the stated country 20 times and server-country 18 times. Discord's ten addresses changed from CA to US, but have no independently confirmed country and are excluded from the score. This small sample is not a measurement of global accuracy.

The adjacent JSON contains DNS responses and hashes. Replay snapshots in `reports/baselines/` include DB-IP November 2026 (CC BY 4.0) and server-country 2026-11-08 (PDDL 1.0); they are excluded from release archives.

```sh
npm run compare:geodb -- --baseline reports/baselines/dbip-2026-11/country.bin.gz --baseline-manifest reports/baselines/dbip-2026-11/manifest.json --candidate reports/baselines/server-country-2026-11-08/country.bin.gz --candidate-manifest reports/baselines/server-country-2026-11-08/manifest.json --dns-snapshot reports/geodb-comparison-2026-11-08.json --out reports/geodb-comparison-replay
```

Remove `--dns-snapshot` to make fresh DNS requests from this comparison script, not from the application.

## IP and domain analysis

`#/analysis` groups traffic by domain, destination IP, outbound proxy, application and destination ASN. Applications are distinguished by device, process path/name and UID. Unknown processes and ASNs remain separate categories; routers generally cannot identify processes on other devices. Search, sorting, node filters and expandable rows connect related domains and addresses. GeoIP/ASN comes from reported core metadata.

**Inbound traffic** groups the same session totals by inbound, TCP/UDP transport or user. Identical user names on different inbounds remain separate; missing metadata is unknown. Transport here is the connection's network, not the outbound proxy protocol.

**Export domains** writes one unique domain per TXT line. It covers the full filtered analysis selection and proxy/IP, device or rule details, including entries beyond the visible page/top list. IP addresses and full URLs are excluded.

Session analytics live in memory and include closed observed connections. The first snapshot establishes starting counters: traffic before the panel connected is excluded. Reloading, switching server or **New session** resets observations. Brief connections between snapshots can be missed. The limit is 20,000 connections per session, with a visible truncation warning. Test: `npm run test:analysis`.

**Domain diagnostics** asks the core's DNS and compares a hostname with active and journaled connections. It shows observed rules, proxy chains and destination IPs. Without an observed connection, DNS answers and rule lists do not predict the route; a shared IP is not proof of a shared route. A pasted HTTP(S) URL is reduced to its hostname. Test: `npm run test:diagnostics`.

DNS types include A, AAAA, CNAME, MX, TXT, NS, SOA, PTR and CAA. A PTR input may be IPv4/IPv6 and is converted to a reverse name. Question, Answer, Authority, Additional and reported flags are shown. Timing measures the panel's request; the API does not identify the actual upstream or a cache hit.

## Connections and journal

**Connections** has active and closed views, with search across host, device, IP, port, process, inbound and proxy. **Columns** toggles type, process, Sniff Host, source/destination, inbound, DNS mode, providers and peak rates, with browser persistence.

Click the host or info control to open details and copyable JSON: endpoints, routing/providers, rule, rates/volumes, process, GeoIP/ASN and other core metadata. Active JSON retains received fields; closed records show the saved known-field subset. Missing data is not reconstructed. If a connection disappears while open, its final snapshot remains with a status label. Tests: `npm run test:connections` and `npm run test:connections:ui`.

Closed records persist in IndexedDB separately for each server. **Settings → Data → Connection journal** offers 1 hour, 24 hours (default), seven days or off, plus clear. The limit is 5,000 records per server. The journal sees only connections captured by an open panel. A disconnection alone does not close records; disappearance after recovery is marked as an observation gap. Last-seen time is not the server's exact closure time. Unavailable storage is reported as tab-memory-only history. Test: `npm run test:journal`.

**Geography** and **Devices** can add observed journal entries from 1 hour, 24 hours or seven days. Filtering uses last observation, within the configured retention. Volumes are lifetime counters of selected connections, not hourly traffic or bytes strictly inside that period. Live snapshots override their journal copy; reused IDs with different start times remain distinct. Historical map entries do not substitute today's DNS answers for past destination addresses.

## Settings transfer and sync

**Settings → Data → Settings transfer** exports server profiles, device names, group sorting, latency preferences, bulk-test selections, language, theme, card size, group height, capture mode and expanded groups. Secrets are excluded by default and require an explicit opt-in. The journal and mihomo configuration are excluded.

Import validates first and previews replacements. Applying merges records; an absent or empty secret never erases the stored one. It does not switch the live connection. Reload is explicit for applying interface preferences. Test: `npm run test:settings-transfer`.

Core sync stores device names, the current core's group sorting and interface preferences at `/storage/miboard.settings.v1`. Server profiles, controller URLs, secrets and journal records are excluded. Save/load are explicit, with previews and conflict rechecks. A conflict requires a fresh preview. The API provides no atomic concurrent-write lock, so a save is verified by reading it back.

## Rules

`#/rules` shows traffic share, rule ranking, the ten top domains of the selected rule and routing chains. Selecting a rule updates domains/routes; panorama includes all rules. The graph supports policy filtering, zoom/pan and paused snapshots.

Volumes sum lifetime download/upload of **currently open connections**, including bytes before the panel opened. Closed connections disappear. This differs from accumulated **IP & domains** session analytics. An interrupted stream retains its last snapshot with an explicit notice.

Click a RuleSet name for source, payload type, record count, format and update time. `/providers/rules` is fetched on first expansion and retained until leaving the page. Inline rules have full-list search with the first 200 matches displayed. HTTP/File sets expose metadata only; inspect their source file for contents. Unsupported APIs or missing sets explain the problem inside the expanded row while the list remains usable.

When the core supplies `index` and `extra`, the list includes match/mismatch counters, last check time and temporary disabling. Sorting preserves server indices. The panel rechecks identity before PATCH and confirms the resulting state with GET. These counters measure rule checks, not traffic. Reloading configuration resets them and temporary disabling. Cores without these fields keep the ordinary rule list.

Tests: `npm run test:rules` and `npm run test:rules:analytics`.

## Core and node diagnostics

Click a node protocol or its provider-table name for diagnostics. For ambiguous same-name group entries, select the provider first. Latency histories are split by URL; a generic history with unknown URL stays separate. The chart, timestamps, median and failures use measurements already held by the core. Reported UDP/UOT/XUDP/TFO/MPTCP/SMUX, interface and dialer-proxy describe adapter configuration, not tested reachability.

**Settings → Connection and core → Core status** shows memory with up to five minutes of observations while this screen is open, network/TUN settings and geodata sources. It is read-only; unavailable fields remain unavailable.

Expandable sections show the actual core log level, TCP keep-alive, LAN restrictions and usernames, TUN routes and exclusions by network, interface, application, UID, MAC and port, plus TUN transport settings. These are configured values; their effects depend on the OS, TUN and routing settings. Lists initially show five entries and expand to reveal the rest. Passwords and raw SS/VMess/TUIC inbound configurations are not displayed.

**Memory profiles** downloads heap or allocations snapshots in Go pprof format, only on request. The core must support pprof and have been started with `log-level: debug`. The panel does not enable debug or force garbage collection. Downloads are limited to 32 MB and canceled on navigation or controller changes. Files are saved locally.

**Logs** requests structured output and also accepts the legacy format. A connection failure before the first valid record triggers one fallback to legacy output. Rows show the core-provided time, falling back to browser receipt time when absent. Expand a row for both available times and extra fields. Search covers messages and fields; field-specific filtering appears only when fields are available. Standard mihomo may return an empty field list. The subscription level does not change the core's logging configuration.

Expanded proxy groups show `emptyFallback` as the exit used when the core's filtered node list is empty. Its active state is not inferred from `all` or `now`, because the core may already insert that fallback into the list. Filtering cards in the panel does not activate it.

Subscription warnings are on by default and configurable per server. They warn below 10% allowance or within three days of expiry, with separate exhausted/expired states. Metadata refreshes every ten minutes while visible without launching health checks. Duplicate warnings are suppressed across reloads and multiple providers are grouped. A closed dashboard does not monitor subscriptions.

Tests: `npm run test:api-tools` and `npm run test:api-tools:ui`. Browser scenarios use isolated mocks, never the user's controller.
