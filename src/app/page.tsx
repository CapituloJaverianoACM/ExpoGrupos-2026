import { CampusExplorer } from "@/components/CampusExplorer";
import { campusData } from "@/lib/campus-data";

/**
 * El dataset se importa como módulo (≈22 KB gzip) en vez de descargarse en runtime:
 * evita el waterfall de red y la dependencia de Overpass en cada visita. Para
 * regenerarlo: `bun run osm:fetch`.
 */
export default function Page() {
  return <CampusExplorer data={campusData} />;
}
