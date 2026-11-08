# Offline GeoIP country data

Source: sapics/ip-location-db, server-country (IPv4 and IPv6).
Snapshot generated: 2026-11-08T20:47:47.963Z.

- Project and source description: https://github.com/sapics/ip-location-db
- IPv4 CSV: https://github.com/sapics/ip-location-db/releases/download/latest/server-country-ipv4.csv
- IPv6 CSV: https://github.com/sapics/ip-location-db/releases/download/latest/server-country-ipv6.csv
- License: Open Data Commons Public Domain Dedication and Licence v1.0 (PDDL-1.0), https://opendatacommons.org/licenses/pddl/1-0/
- The publisher offers server-country under PDDL; attribution is not required.
- Source SHA-256 snapshots, checksum URLs and output checksum are recorded in manifest.json.

The publisher describes server-country as prioritizing the physical server or relay point.
Country labels are dataset estimates, not precise locations or a measured accuracy claim.
The source CSV ranges are validated for order and overlap, uncovered ranges become ZZ,
and adjacent ranges with the same country are merged before encoding.

country.bin.gz is bundled with the dashboard. IP lookup runs locally in the browser;
destination IPs are never submitted to the dataset publisher or a geolocation service.
Rebuild from the current checksum-verified release: npm run update:geodb.
Local snapshots: node scripts/update-geodb.mjs --ipv4-file ipv4.csv --ipv6-file ipv6.csv.

## MIG1 binary format

All header integers are little-endian. Header: ASCII MIG1, uint16 country count,
uint32 IPv4 range count, uint32 IPv6 range count; then two ASCII characters per country.
IPv4 records precede IPv6 records. Each record is an unsigned LEB128 delta from the
previous inclusive endpoint (initially -1), followed by one uint8 country index.
Ranges cover each complete address family; ZZ means unknown. Lookup rejects private,
fake, documentation and other non-public ranges before consulting the database.
