# Offline GeoIP country data

Source: DB-IP Country Lite, November 2026.

- Original download: https://download.db-ip.com/free/dbip-country-lite-2026-11.csv.gz
- Provider and terms: https://db-ip.com/db/download/ip-to-country-lite
- License: Creative Commons Attribution 4.0 International (CC BY 4.0), https://creativecommons.org/licenses/by/4.0/
- Required web attribution: [IP Geolocation by DB-IP](https://db-ip.com).

The data has been transformed from CSV ranges into delta-encoded range endpoints
and country indices, then gzip-compressed. Country boundaries and accuracy are
those of the free DB-IP Lite dataset. This is a country database, not a city or
precise location database. Rebuild with `node scripts/update-geodb.mjs YYYY-MM`.
The source and generated SHA-256 checksums are recorded in `manifest.json`.

`country.bin.gz` is bundled with the dashboard. Browser lookups run locally;
destination IPs are never submitted to DB-IP or to another geolocation service.

## MIG1 binary format

All header integers are little-endian. Header: ASCII `MIG1`, uint16 country count,
uint32 IPv4 range count, uint32 IPv6 range count; then two ASCII characters for
each country. IPv4 records precede IPv6 records. Each record is an unsigned LEB128
delta from the previous inclusive range endpoint (starting at -1), followed by
one uint8 country index. Ranges are consecutive and cover the entire address
family; `ZZ` means unknown. Lookup rejects private, fake, documentation and other
non-public address ranges before consulting the database.
