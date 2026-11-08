// Rebuild the committed, offline Equal Earth map. Development only: npm install -D d3-geo
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { geoEqualEarth, geoGraticule10, geoPath } from 'd3-geo'

const source = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/'
const [outline, detail, units50, units10] = await Promise.all([
  '110m_admin_0_countries',
  '50m_admin_0_countries',
  '50m_admin_0_map_units',
  '10m_admin_0_map_units',
].map(async (dataset) => {
  const response = await fetch(`${source}ne_${dataset}.geojson`)
  if (!response.ok) throw new Error(`Natural Earth ${dataset}: HTTP ${response.status}`)
  return response.json()
}))

const width = 1000
const height = 560
const projection = geoEqualEarth().fitExtent([[24, 24], [width - 24, height - 24]], { type: 'Sphere' })
const path = geoPath(projection).digits(1)
const round = (point) => point.map((value) => Math.round(value * 10) / 10)
const codeOf = ({ properties: p }) => {
  const code = p.ISO_A2_EH !== '-99' ? p.ISO_A2_EH : p.ISO_A2
  // Natural Earth's Kosovo identifier predates common GeoIP's XK code.
  return /^[A-Z]{2}$/.test(code) ? code : p.ADM0_A3 === 'KOS' ? 'XK' : null
}

const shapes = new Map()
for (const feature of outline.features) {
  const code = codeOf(feature)
  const key = code ?? feature.properties.ADM0_A3
  shapes.set(key, {
    code: key,
    name: feature.properties.NAME_RU || feature.properties.NAME,
    path: path(feature),
    point: round(projection([feature.properties.LABEL_X, feature.properties.LABEL_Y])),
  })
}

// Add the location of small countries/territories omitted by the 110m outline.
// A point means the country is present without exaggerating its geographic area.
for (const feature of [...detail.features, ...units50.features, ...units10.features]) {
  const code = codeOf(feature)
  if (!code || shapes.has(code)) continue
  shapes.set(code, {
    code,
    name: feature.properties.NAME_RU || feature.properties.NAME,
    path: '',
    point: round(projection([feature.properties.LABEL_X, feature.properties.LABEL_Y])),
  })
}

// The UM region comprises disconnected islands. Natural Earth records its map
// units under US; Wake provides a source-derived representative point for UM.
const wake = units10.features.find(({ properties: p }) =>
  p.ADMIN === 'United States Minor Outlying Islands' && p.NAME === 'Wake Atoll',
)
if (!wake) throw new Error('Natural Earth is missing the UM representative point')
shapes.set('UM', {
  code: 'UM',
  name: 'Малые Тихоокеанские отдалённые острова США',
  path: '',
  point: round(projection([wake.properties.LABEL_X, wake.properties.LABEL_Y])),
})

const data = {
  width,
  height,
  sphere: path({ type: 'Sphere' }),
  graticule: path(geoGraticule10()),
  countries: [...shapes.values()].sort((a, b) => a.code.localeCompare(b.code)),
}
const destination = fileURLToPath(new URL('../src/lib/data/', import.meta.url))
await mkdir(destination, { recursive: true })
const serialized = JSON.stringify(data)
await writeFile(`${destination}/equal-earth.json`, serialized + '\n')
console.log(`Equal Earth: ${data.countries.length} regions, ${Math.round(Buffer.byteLength(serialized) / 1024)} KB, no runtime map dependency`)
