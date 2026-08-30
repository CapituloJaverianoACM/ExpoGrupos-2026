import raw from "@/data/places.json";
import type { PlacesData } from "./types";

/**
 * Misma aserción y mismo motivo que en campus-data.ts y terrain-data.ts.
 *
 * Los tres datasets comparten el origen de proyección de campus.json; ver
 * `scripts/fetch-places.ts`. Si se regenera uno, hay que regenerar los tres.
 */
export const placesData = raw as unknown as PlacesData;
