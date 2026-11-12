import { useEffect, useRef } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { t } from '../../../src/i18n'

// Leaflet 1.9.4 reads window at module scope. Node extraction must never import it.
export function TrasaView({ record }: { record: Record<string, unknown> }) {
  const target = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const map = L.map(target.current!, { zoomControl: true }).setView([50.0755, 14.4378], 12)
    // No remote tiles/network dependency; real Leaflet renders local vector stops.
    L.circleMarker([50.0755, 14.4378], { radius: 14, color: '#146b58' }).addTo(map).bindTooltip(String(record.name))
    L.polyline([[50.0755, 14.4378], [50.087, 14.421], [50.099, 14.45]], { color: '#146b58' }).addTo(map)
    return () => { map.remove() }
  }, [record.name])
  return <section className="card"><h2>{t('workers.trasa.stops', { name: String(record.name) })}</h2><div className="map" ref={target} aria-label={t('workers.trasa.title')} /><p>{t('workers.trasa.offline')}</p></section>
}
