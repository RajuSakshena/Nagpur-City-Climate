import React, { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { MapContainer, TileLayer, useMap, useMapEvents } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";
import {
  Thermometer, Map as MapIcon,
  Activity, Satellite, Globe, Database, Info, X, ChevronRight,
} from "lucide-react";
// @ts-ignore
import * as GeoTIFF from "geotiff";

// ─── Types ────────────────────────────────────────────────────────────────────

type MapType   = "osm" | "satellite" | "hybrid";
type LayerType = "lst" | "ndvi" | "rain" | "soil" | "water" | "lulc";

interface RealStats {
  avg: number; min: number; max: number;
  hotPct: number; modPct: number; coolPct: number; count: number;
  tiffDerived: boolean;   // true = real TIFF pixels, false = TIFF not loaded
}

interface AnnualMeans {
  ndvi: number; lst: number; rain: number; soil: number; water: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const N_WEEKS = 52;

// ─── Tile Configuration ───────────────────────────────────────────────────────

const AVAILABLE_YEARS: number[]    = [2015, 2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
const TILES_AVAILABLE_YEARS        = new Set(AVAILABLE_YEARS);
const DEFAULT_YEAR                 = 2025;

function getTileUrl(year: number): string | null {
  return TILES_AVAILABLE_YEARS.has(year) ? `/tiles/${year}/{z}/{x}/{y}.png` : null;
}

function getCogUrl(year: number): string {
  return `https://huggingface.co/datasets/Jackmyble/nagpur-climate-cog/resolve/main/Nagpur_Weekly_${year}_cog.tif`;
}

// ─── COG TIFF Sampler — WITH FULL DEBUGGING ──────────────────────────────────

interface TiffCache {
  bands: (Float32Array | Int16Array | Uint8Array)[];  // Array of per-band typed arrays
  width: number;
  height: number;
  bbox: number[];
  nodata: number | null;
  totalBands: number;
}

const TIFF_CACHE_MAP  = new Map<number, TiffCache>();
const TIFF_LOADING_SET = new Set<number>();

// Convenience accessor used by sampling / stats helpers (set by loadMainTiff)
let TIFF_CACHE: TiffCache | null = null;
let _ACTIVE_YEAR = DEFAULT_YEAR;

// ─── Full-band stats helper (used during load for diagnostics) ────────────────
function fullBandStats(band: ArrayLike<number>, nodataVal: number | null): {
  min: number; max: number; avg: number | null; count: number; first20: number[];
} {
  let min = Infinity, max = -Infinity, sum = 0, count = 0;
  const first20: number[] = [];
  for (let i = 0; i < band.length; i++) {
    const v = (band as any)[i] as number;
    if (i < 20) first20.push(v);
    // Strict: reject NaN, ±Infinity, -9999, and explicit nodata
    if (!Number.isFinite(v) || v === -9999 || (nodataVal !== null && v === nodataVal)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    count++;
  }
  return { min: count > 0 ? min : 0, max: count > 0 ? max : 0, avg: count > 0 ? sum / count : null, count, first20 };
}

async function loadMainTiff(year: number = DEFAULT_YEAR): Promise<TiffCache | null> {
  if (TIFF_CACHE_MAP.has(year)) {
    const cached = TIFF_CACHE_MAP.get(year)!;
    TIFF_CACHE   = cached;
    return cached;
  }
  if (TIFF_LOADING_SET.has(year)) return null;
  TIFF_LOADING_SET.add(year);

  try {
    const cogUrl = getCogUrl(year);
    const tiff = await GeoTIFF.fromUrl(cogUrl);

    console.log(`=== TIFF LOAD START (year=${year}) ===`);
    const imageCount = await tiff.getImageCount();
    console.log("imageCount:", imageCount);

    const image = await tiff.getImage();
    const W     = image.getWidth();
    const H     = image.getHeight();
    const nBands = image.getSamplesPerPixel();
    const bbox  = image.getBoundingBox();
    const fileDirectory = image.fileDirectory as any;
    const nodataRaw = Number(fileDirectory?.GDAL_NODATA ?? NaN);
    const nodata = Number.isNaN(nodataRaw) ? null : nodataRaw;

    console.log(`Dimensions: ${W} × ${H}  |  SamplesPerPixel: ${nBands}  |  NODATA: ${nodata}`);
    console.log("BBOX:", bbox);
    console.log("BitsPerSample:", fileDirectory?.BitsPerSample);
    console.log("SampleFormat:", fileDirectory?.SampleFormat);

    // ── Read all bands as separate arrays (band-sequential) ──────────────────
    const rastersRaw = await image.readRasters();   // returns TypedArray[] per band
    const bandsArray: (Float32Array | Int16Array | Uint8Array)[] = Array.isArray(rastersRaw)
      ? rastersRaw as (Float32Array | Int16Array | Uint8Array)[]
      : [rastersRaw as Float32Array | Int16Array | Uint8Array];

    const totalBands = bandsArray.length;
    console.log(`Total bands in file: ${totalBands}  (expected: ${N_WEEKS * 6} = ${N_WEEKS * 6})`);

    // ── DIAGNOSTIC: print stats for ALL 6 layers × 4 sample weeks ────────────
    // week_band = weekIndex * 6 + offset
    // offsets: NDVI=0  LST=1  Rain=2  Soil=3  Water=4  LULC=5
    const LAYER_NAMES = ["NDVI","LST","Rain","Soil","Water","LULC"] as const;
    const PROBE_WEEKS = [0, 1, 10, 25];   // weeks 1, 2, 11, 26

    console.log("\n=== PER-LAYER PER-WEEK BAND DIAGNOSTICS ===");
    console.log("Format:  bandIdx | layer | week | type | min | max | avg | first5");
    for (const wi of PROBE_WEEKS) {
      for (let offset = 0; offset < 6; offset++) {
        const bi = wi * 6 + offset;
        const layerName = LAYER_NAMES[offset];
        if (bi >= totalBands) {
          console.warn(`  [MISSING] week${wi} ${layerName} → band ${bi} out of range (total ${totalBands})`);
          continue;
        }
        const band = bandsArray[bi];
        const s    = fullBandStats(band, nodata);
        console.log(
          `  band${String(bi).padStart(3," ")} | ${layerName.padEnd(5," ")} | wk${String(wi).padStart(2,"0")}` +
          ` | ${band.constructor.name.padEnd(12," ")}` +
          ` | min=${s.min.toFixed(4).padStart(10," ")}` +
          ` | max=${s.max.toFixed(4).padStart(10," ")}` +
          ` | avg=${s.avg !== null ? s.avg.toFixed(4).padStart(10," ") : "      null"}` +
          ` | first5=[${s.first20.slice(0,5).map(v=>v.toFixed(3)).join(", ")}]`
        );
      }
      console.log("  ---");
    }

    // ── SOIL-SPECIFIC DIAGNOSIS ───────────────────────────────────────────────
    console.log("\n=== SOIL BAND DEEP DIAGNOSIS (band_index = weekIndex*6 + 3) ===");
    const SOIL_CHECK_WEEKS = [0, 1, 2, 10];
    for (const wi of SOIL_CHECK_WEEKS) {
      const bi = wi * 6 + 3;
      if (bi >= totalBands) { console.warn(`  soil week${wi} band${bi} missing`); continue; }
      const band = bandsArray[bi];
      const s    = fullBandStats(band, nodata);
      console.log(`  week${wi} soil band${bi}: min=${s.min} max=${s.max} avg=${s.avg?.toFixed(4)} count=${s.count}`);
      console.log(`    first20: [${s.first20.map(v=>v.toFixed(4)).join(", ")}]`);

      // Check for saturation — if max ≤ 1.001 and min ≥ 0.999 it's clipped
      const saturated = s.max <= 1.001 && s.min >= 0.998 && s.count > 100;
      if (saturated) {
        console.error(`  ⚠️  SOIL BAND ${bi} APPEARS SATURATED (all values ≈ 1.0)`);
        console.error(`     GEE export likely used wrong divisor. Raw TerraClimate 'soil' values`);
        console.error(`     are in mm×0.1 units (~0-4000). Dividing by 500 clips everything ≥500.`);
        console.error(`     RECOMMENDED FIX IN GEE: .divide(500).max(0).min(1) → check raw range first.`);
      } else if (s.max > 1.001) {
        // Values > 1 means NOT scaled yet or scaled wrong
        console.warn(`  ⚠️  SOIL BAND ${bi} values exceed 1.0 (max=${s.max}) — may need scaling.`);
      } else {
        console.log(`  ✓  SOIL BAND ${bi} looks plausible (min=${s.min.toFixed(4)} max=${s.max.toFixed(4)})`);
      }
    }

    // ── WATER-SPECIFIC DIAGNOSIS ──────────────────────────────────────────────
    console.log("\n=== WATER BAND DEEP DIAGNOSIS (band_index = weekIndex*6 + 4) ===");
    for (const wi of [0, 10, 30]) {
      const bi = wi * 6 + 4;
      if (bi >= totalBands) continue;
      const band = bandsArray[bi];
      const s    = fullBandStats(band, nodata);
      console.log(`  week${wi} water band${bi}: min=${s.min.toFixed(2)} max=${s.max.toFixed(2)} avg=${s.avg?.toFixed(2)} (expected 0–100)`);
    }

    // ── LULC-SPECIFIC DIAGNOSIS ───────────────────────────────────────────────
    console.log("\n=== LULC BAND DEEP DIAGNOSIS (band_index = weekIndex*6 + 5) ===");
    for (const wi of [0, 26]) {
      const bi = wi * 6 + 5;
      if (bi >= totalBands) continue;
      const band = bandsArray[bi];
      const s    = fullBandStats(band, nodata);
      console.log(`  week${wi} lulc band${bi}: min=${s.min.toFixed(1)} max=${s.max.toFixed(1)} avg=${s.avg?.toFixed(2)} (expected 0–8 integers)`);
    }

    console.log("=== TIFF LOAD END ===\n");

    const cache: TiffCache = {
      bands: bandsArray,
      totalBands,
      width:  W,
      height: H,
      bbox,
      nodata,
    };
    TIFF_CACHE_MAP.set(year, cache);
    TIFF_CACHE = cache;
    _ACTIVE_YEAR = year;

    // Run auto-scale detection — fills DETECTED_SCALE and BAND_DIAGNOSTICS
    detectAndLogScales(bandsArray, nodata);

    // Clear any stale heatmap renders now that TIFF + scales are finalised
    clearHeatmapCache();

    return TIFF_CACHE;
  } catch (err) {
    console.error(`COG load failed (year=${year})`, err);
    TIFF_LOADING_SET.delete(year);
    return null;
  }
}

// ─── OFFICIAL BAND OFFSETS from GEE export script ─────────────────────────────
// band_index = week_index * 6 + layer_offset
const BAND_OFFSETS: Record<LayerType, number> = {
  ndvi:  0,
  lst:   1,   // Temperature °C — CRITICAL: offset 1, NOT 0
  rain:  2,
  soil:  3,
  water: 4,
  lulc:  5,
};

function getBandIndex(layer: LayerType, weekIndex: number): number {
  return weekIndex * 6 + BAND_OFFSETS[layer];
}

function sampleTiffValue(layer: LayerType, weekIndex: number, lat: number, lng: number): number | null {
  if (!TIFF_CACHE) return null;

  const { bands, width, height, bbox, nodata } = TIFF_CACHE;
  const [minX, minY, maxX, maxY] = bbox;

  const x = Math.floor(((lng - minX) / (maxX - minX)) * width);
  const y = Math.floor(((maxY - lat) / (maxY - minY)) * height);

  if (x < 0 || x >= width || y < 0 || y >= height) return null;

  const pixelIndex = y * width + x;
  const bandIndex  = getBandIndex(layer, weekIndex);

  if (bandIndex < 0 || bandIndex >= bands.length) return null;

  const band = bands[bandIndex];
  if (!band || pixelIndex >= band.length) return null;

  const value = band[pixelIndex] as number;
  if (!Number.isFinite(value) || value === nodata || value === -9999) return null;
  // Apply per-layer scale correction detected from actual TIFF data range
  return value * DETECTED_SCALE[layer];
}

// ─── Real TIFF Band Statistics ────────────────────────────────────────────────
// Computes min/max/avg from actual TIFF band pixels — zero hardcoded values.
// scaleFactor is applied to every valid pixel (1.0 = raw value, default).

function computeBandStats(
  band: Float32Array | Int16Array | Uint8Array,
  nodata: number | null,
  scaleFactor: number = 1,
): {
  min: number; max: number; avg: number | null; count: number;
} {
  let min   = Infinity;
  let max   = -Infinity;
  let sum   = 0;
  let count = 0;

  for (let i = 0; i < band.length; i++) {
    const v = band[i] as number;
    if (!Number.isFinite(v) || v === -9999 || (nodata !== null && v === nodata)) continue;
    const sv = v * scaleFactor;
    if (!Number.isFinite(sv)) continue; // guard post-scale
    if (sv < min) min = sv;
    if (sv > max) max = sv;
    sum += sv;
    count++;
  }

  return {
    min:   count > 0 ? min : 0,
    max:   count > 0 ? max : 0,
    avg:   count > 0 ? sum / count : null,
    count,
  };
}

// Compute TIFF-derived hot/moderate/cool zone percentages from real pixel distribution
function computeZonePcts(band: Float32Array | Int16Array | Uint8Array, nodata: number | null, _avg: number): {
  hotPct: number; modPct: number; coolPct: number;
} {
  const hot   = 32;   // °C — pixels above this = "hot"
  const cool  = 24;   // °C — pixels below this = "cool"
  const scale = DETECTED_SCALE["lst"];
  let hotN  = 0, coolN = 0, modN = 0;

  for (let i = 0; i < band.length; i++) {
    const raw = band[i] as number;
    if (!Number.isFinite(raw) || raw === -9999 || (nodata !== null && raw === nodata)) continue;
    const v = raw * scale;
    if (!Number.isFinite(v)) continue;
    if      (v > hot)  hotN++;
    else if (v < cool) coolN++;
    else               modN++;
  }
  const total = hotN + modN + coolN || 1;
  return {
    hotPct:  (hotN  / total) * 100,
    modPct:  (modN  / total) * 100,
    coolPct: (coolN / total) * 100,
  };
}

// Synchronously extract real stats from the TIFF cache for the given layer+week.
// Returns null if TIFF not yet loaded.
function getTiffStats(layer: LayerType, weekIndex: number): RealStats | null {
  if (!TIFF_CACHE) return null;
  const { bands, nodata } = TIFF_CACHE;
  const bandIndex = getBandIndex(layer, weekIndex);
  if (bandIndex < 0 || bandIndex >= bands.length) return null;

  const band  = bands[bandIndex];
  const scale = DETECTED_SCALE[layer];
  const stats = computeBandStats(band, nodata, scale);
  if (stats.avg === null) return null;

  let hotPct = 0, modPct = 100, coolPct = 0;
  if (layer === "lst") {
    const zones = computeZonePcts(band, nodata, stats.avg);
    hotPct  = zones.hotPct;
    modPct  = zones.modPct;
    coolPct = zones.coolPct;
  }

  return {
    avg:     stats.avg,
    min:     stats.min,
    max:     stats.max,
    hotPct,
    modPct,
    coolPct,
    count:   stats.count,
    tiffDerived: true,
  };
}

// Compute annual mean across all 52 weeks for a layer from TIFF data
function getTiffAnnualMeans(): AnnualMeans | null {
  if (!TIFF_CACHE) return null;
  const layers: LayerType[] = ["ndvi", "lst", "rain", "soil", "water"];
  const result: Partial<AnnualMeans> = {};

  for (const layer of layers) {
    let weekSum = 0; let weekCount = 0;
    const scale = DETECTED_SCALE[layer];
    for (let wi = 0; wi < N_WEEKS; wi++) {
      const bandIndex = getBandIndex(layer, wi);
      if (bandIndex < 0 || bandIndex >= TIFF_CACHE.bands.length) continue;
      const band  = TIFF_CACHE.bands[bandIndex];
      const stats = computeBandStats(band, TIFF_CACHE.nodata, scale);
      if (stats.avg !== null) { weekSum += stats.avg; weekCount++; }
    }
    const key = layer === "lst" ? "lst" : layer;
    (result as Record<string, number>)[key] = weekCount > 0 ? weekSum / weekCount : 0;
  }

  return result as AnnualMeans;
}

// ─── Auto-scale detection & per-layer scale corrections ──────────────────────
//
// After TIFF loads we inspect the actual data range of each layer (using week 26
// = mid-monsoon, which has non-trivial values for all layers) and decide whether
// the band needs a frontend scale correction because the GEE export used the
// wrong divisor.
//
// RULES:
//   NDVI:  native range −1…+1 → no scale needed
//   LST:   native range 5…55°C → no scale needed
//   Rain:  native range 0…500 mm/wk → no scale needed
//   Soil:  exported as raw ÷ 500. If raw max ≤ 1.001 AND suspiciously uniform
//          the GEE export already applied the divisor.  If raw max >> 1 (e.g. 800)
//          we need to divide by the detected range to get 0–1.
//   Water: native 0–100 % → no scale needed
//   LULC:  integer 0–8 → no scale needed
//
// The detected SCALE_CORRECTIONS are applied by getTiffStats / sampleTiffValue.

interface BandDiagnostic {
  bandIndex:   number;
  rawMin:      number;
  rawMax:      number;
  rawAvg:      number | null;
  saturated:   boolean;   // all pixels ≈ same value → bad GEE export
  scaleApplied: number;   // multiplier applied to raw value for display (usually 1)
  warning:     string | null;
}

// Populated once after TIFF loads; keyed by "layer:weekIndex"
const BAND_DIAGNOSTICS = new Map<string, BandDiagnostic>();

// Per-layer scale correction factor — determined from actual TIFF data range.
// Applied as:  displayValue = rawTiffValue * scaleFactor
// Default = 1 (no correction).
const DETECTED_SCALE: Record<LayerType, number> = {
  ndvi: 1, lst: 1, rain: 1, soil: 1, water: 1, lulc: 1,
};

// Set to true once detectAndLogScales runs and soil is found temporally corrupt.
// UI reads this to surface "UNRELIABLE — re-export GEE" warnings. Not a correction.
let SOIL_DATA_UNRELIABLE = false;

// Called once after TIFF loads — fills DETECTED_SCALE and BAND_DIAGNOSTICS
function detectAndLogScales(bands: (Float32Array | Int16Array | Uint8Array)[], nodata: number | null) {
  console.log("\n=== AUTO-SCALE DETECTION ===");

  // Use week 26 (index 26, mid-monsoon) as reference — should have real values
  const PROBE_WI    = 26;
  const layerKeys   = ["ndvi", "lst", "rain", "soil", "water", "lulc"] as LayerType[];
  const offsets     = [0, 1, 2, 3, 4, 5];

  layerKeys.forEach((layer, i) => {
    const bi   = PROBE_WI * 6 + offsets[i];
    if (bi >= bands.length) return;
    const band = bands[bi];
    const s    = fullBandStats(band, nodata);

    // Saturation check: >95% of valid pixels are within 0.002 of the max
    let nearMaxCount = 0;
    if (s.max !== s.min) {
      for (let j = 0; j < band.length; j++) {
        const v = (band as any)[j] as number;
        if (!Number.isFinite(v) || v === -9999 || (nodata !== null && v === nodata)) continue;
        if (Math.abs(v - s.max) < 0.002) nearMaxCount++;
      }
    }
    const saturated = s.count > 0 && nearMaxCount / s.count > 0.95;

    let scaleApplied = 1;
    let warning: string | null = null;

    if (layer === "soil") {
      // ── Soil: check MULTIPLE weeks, not just probe week, to detect temporal corruption ──
      // Findings from browser diagnostics:
      //   week 0:  min≈0.9, max≈1.0, avg≈0.9998  → SATURATED (GEE .min(1) clipped)
      //   week 10: min=0,   max=0,   avg=0         → DEAD BAND (masked / zero-fill)
      //   week 25: min=0,   max=0,   avg=0         → DEAD BAND
      // Conclusion: data is TEMPORALLY CORRUPT and unreliable at source.
      // Frontend MUST NOT fabricate corrections. Mark as unreliable.
      const soilCheckWeeks = [0, 1, 10, 25, 30];
      let saturatedCount = 0, deadCount = 0, plausibleCount = 0;
      for (const wi of soilCheckWeeks) {
        const sbi = wi * 6 + 3;
        if (sbi >= bands.length) continue;
        const sb = bands[sbi];
        const ss = fullBandStats(sb, nodata);
        if (ss.count === 0 || (ss.max === 0 && ss.min === 0)) {
          deadCount++;
        } else if (ss.max <= 1.001 && ss.min >= 0.90 && ss.count > 50) {
          saturatedCount++;
        } else if (ss.max > 0.001 && ss.max <= 1.001) {
          plausibleCount++;
        } else if (ss.max > 1.001) {
          // raw unscaled values
          plausibleCount++;
        }
      }
      const isTemporallyCorrupt = saturatedCount > 0 || deadCount > 0;
      if (isTemporallyCorrupt) {
        warning = `TEMPORALLY CORRUPT: ${saturatedCount} week(s) saturated ≈1.0 (GEE .min(1) clipping), ` +
                  `${deadCount} week(s) fully dead (zero-fill or masked). ` +
                  `Data is unreliable. FIX IN GEE: check raw TerraClimate range with ` +
                  `ee.Reducer.minMax() before dividing. Some weeks may be masked by cloud/data gaps.`;
        scaleApplied = 1; // cannot fix without re-export
        console.error(`⚠️  SOIL TEMPORAL CORRUPTION DETECTED:`);
        console.error(`   Saturated weeks: ${saturatedCount}, Dead weeks: ${deadCount}, Plausible weeks: ${plausibleCount}`);
        console.error(`   ${warning}`);
      } else if (s.max > 1.001) {
        const correctDivisor = s.max < 10 ? 1 : s.max < 100 ? 10 : s.max < 1000 ? 100 : 500;
        scaleApplied = 1 / correctDivisor;
        warning = `Raw soil values out of 0–1 range (max=${s.max.toFixed(1)}). Auto-applying 1/${correctDivisor} scale.`;
        console.warn(`⚠️  SOIL: ${warning}`);
      } else {
        console.log(`✓  SOIL: values in 0–1 range (min=${s.min.toFixed(3)}, max=${s.max.toFixed(3)})`);
      }
    } else if (layer === "water") {
      if (s.max > 100.1) {
        scaleApplied = 100 / s.max;
        warning = `Raw water values exceed 100 (max=${s.max.toFixed(1)}). Auto-scaling to 0–100.`;
        console.warn(`⚠️  WATER: ${warning}`);
      } else if (s.max <= 1.001 && s.avg !== null && s.avg < 0.5) {
        // Water in 0–1 fraction, not 0–100 %
        scaleApplied = 100;
        warning = `Water appears to be 0–1 fraction (max=${s.max.toFixed(3)}), scaling ×100 to get %.`;
        console.warn(`⚠️  WATER: ${warning}`);
      } else {
        console.log(`✓  WATER: values 0–100% range (min=${s.min.toFixed(2)}, max=${s.max.toFixed(2)})`);
      }
    } else if (layer === "ndvi") {
      if (s.min > -0.1 && s.max > 1.1) {
        warning = `NDVI max=${s.max.toFixed(3)} exceeds 1.0 — possible scale error in GEE export.`;
        console.warn(`⚠️  NDVI: ${warning}`);
      } else {
        console.log(`✓  NDVI: range −1…+1 (min=${s.min.toFixed(3)}, max=${s.max.toFixed(3)})`);
      }
    } else if (layer === "lst") {
      if (s.min < 5 || s.max > 60) {
        warning = `LST out of expected 5–55°C range (min=${s.min.toFixed(1)}, max=${s.max.toFixed(1)}). Check Kelvin conversion.`;
        console.warn(`⚠️  LST: ${warning}`);
      } else {
        console.log(`✓  LST: ${s.min.toFixed(1)}–${s.max.toFixed(1)}°C (plausible)`);
      }
    } else if (layer === "rain") {
      if (s.max > 600) {
        warning = `Rain max=${s.max.toFixed(1)} mm/wk seems high — verify CHIRPS is weekly sum.`;
        console.warn(`⚠️  RAIN: ${warning}`);
      } else {
        console.log(`✓  RAIN: 0–${s.max.toFixed(1)} mm/wk`);
      }
    } else if (layer === "lulc") {
      if (s.min < -0.5 || s.max > 8.5) {
        warning = `LULC values out of 0–8 range (min=${s.min.toFixed(1)}, max=${s.max.toFixed(1)}).`;
        console.warn(`⚠️  LULC: ${warning}`);
      } else {
        console.log(`✓  LULC: classes ${s.min.toFixed(0)}–${s.max.toFixed(0)} (expected 0–8)`);
      }
    }

    DETECTED_SCALE[layer] = scaleApplied;

    // Mark soil as unreliable if temporal corruption was detected
    if (layer === "soil" && warning !== null) {
      SOIL_DATA_UNRELIABLE = true;
    }

    BAND_DIAGNOSTICS.set(`${layer}:${PROBE_WI}`, {
      bandIndex: bi, rawMin: s.min, rawMax: s.max, rawAvg: s.avg,
      saturated, scaleApplied, warning,
    });

    console.log(`   Scale factor for ${layer}: ×${scaleApplied}`);
  });

  console.log("=== AUTO-SCALE DETECTION END ===\n");
}

// Pre-warm COG TIFF so it's ready before user hovers
function prewarmTiffs(year: number = DEFAULT_YEAR) {
  loadMainTiff(year);
}

// ─── Date Helpers ─────────────────────────────────────────────────────────────

function dateFromWeek(year: number, weekIndex: number): Date {
  const start = new Date(year, 0, 1);
  start.setDate(1 + weekIndex * 7);
  return start;
}

function dateEndFromWeek(year: number, weekIndex: number): Date {
  const d = dateFromWeek(year, weekIndex);
  d.setDate(d.getDate() + 6);
  if (d.getFullYear() > year) return new Date(year, 11, 31);
  return d;
}

function formatDateShort(date: Date): string {
  return date.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

// ─── Layer Metadata ───────────────────────────────────────────────────────────

const LAYER_META: Record<LayerType, { name: string; desc: string; dotColor: string; emoji: string; label: string }> = {
  lst:   { name: "Temperature", desc: "Land Surface Temp",  dotColor: "#f97316", emoji: "🌡",  label: "Temp"  },
  ndvi:  { name: "NDVI",        desc: "Vegetation Index",   dotColor: "#16a34a", emoji: "🌿",  label: "NDVI"  },
  rain:  { name: "Rainfall",    desc: "Weekly Rainfall",    dotColor: "#0284c7", emoji: "🌧",  label: "Rain"  },
  soil:  { name: "Soil Moist.", desc: "Soil Moisture",      dotColor: "#65a30d", emoji: "🌱",  label: "Soil"  },
  water: { name: "Water Cover", desc: "Surface Water %",    dotColor: "#06b6d4", emoji: "💧",  label: "Water" },
  lulc:  { name: "Land Use",    desc: "LULC Class",         dotColor: "#8b5cf6", emoji: "🗺",  label: "LULC"  },
};

const LAYER_LEGEND: Record<LayerType, { gradient: string; lowLabel: string; highLabel: string }> = {
  lst:   { gradient: "linear-gradient(to right,#0000c8,#00c8c8,#50ff00,#ffff00,#ff9900,#ff4100,#c80000)", lowLabel: "Cool", highLabel: "Hot" },
  ndvi:  { gradient: "linear-gradient(to right,#7f1d1d,#fde047,#16a34a)", lowLabel: "Low Veg", highLabel: "High Veg" },
  rain:  { gradient: "linear-gradient(to right,#bae6fd,#38bdf8,#0369a1)", lowLabel: "Low Rain", highLabel: "Heavy Rain" },
  soil:  { gradient: "linear-gradient(to right,#fde047,#84cc16,#166534)", lowLabel: "Dry", highLabel: "Wet" },
  water: { gradient: "linear-gradient(to right,#e0f2fe,#38bdf8,#0369a1)", lowLabel: "0%", highLabel: "100%" },
  lulc:  { gradient: "linear-gradient(to right,#1d4ed8,#22c55e,#ca8a04,#f97316,#7c3aed,#6b7280)", lowLabel: "Water", highLabel: "Bare/Snow" },
};

const BASEMAPS: { id: MapType; label: string; icon: React.ElementType }[] = [
  { id: "osm",       label: "OSM", icon: Globe },
  { id: "satellite", label: "SAT", icon: Satellite },
  { id: "hybrid",    label: "HYB", icon: MapIcon },
];

const DATA_SOURCES = [
  { label: "NDVI",          value: "Sentinel-2 SR Harmonized + Landsat 7/8/9", dot: "#16a34a" },
  { label: "LULC",          value: "Dynamic World V1 + ESA WorldCover",         dot: "#7c3aed" },
  { label: "Water Cover",   value: "JRC Monthly Surface Water v1.4",            dot: "#0891b2" },
  { label: "LST (Temp)",    value: "MODIS Terra/Aqua Day+Night + ERA5-Land",    dot: "#ea580c" },
  { label: "Rainfall",      value: "CHIRPS Daily (weekly sum)",                  dot: "#0284c7" },
  { label: "Soil Moisture", value: "TerraClimate (normalized ÷ 500)",            dot: "#65a30d" },
];

const LULC_CLASSES = [
  { label: "0 Water",    color: "#1d4ed8" },
  { label: "1 Trees",    color: "#15803d" },
  { label: "2 Grass",    color: "#86efac" },
  { label: "3 Flooded",  color: "#67e8f9" },
  { label: "4 Crops",    color: "#ca8a04" },
  { label: "5 Shrub",    color: "#84cc16" },
  { label: "6 Built",    color: "#f97316" },
  { label: "7 Bare",     color: "#a16207" },
  { label: "8 Snow/Ice", color: "#e0f2fe" },
];

const YEARS       = AVAILABLE_YEARS;
const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

const sectionLabel: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#374151",
  marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.06em",
};

// ─── Layer Info ───────────────────────────────────────────────────────────────

interface LayerInfoDetail {
  title: string; emoji: string; accentColor: string; bgColor: string;
  source: string; sourceShort: string; dataset: string; resolution: string;
  calculation: string; calcSteps: string[]; unit: string;
  valueRanges: { range: string; meaning: string; color: string }[];
  chartExplain: string; notes: string;
}

const LAYER_INFO: Record<LayerType, LayerInfoDetail> = {
  ndvi: {
    title: "NDVI — Normalized Difference Vegetation Index",
    emoji: "🌿", accentColor: "#16a34a", bgColor: "#f0fdf4",
    source: "Sentinel-2 SR Harmonized (primary) + Landsat 9/8/7 fallback",
    sourceShort: "Sentinel-2 + Landsat",
    dataset: "COPERNICUS/S2_SR_HARMONIZED · LANDSAT/LC09 · LANDSAT/LC08 · LANDSAT/LE07",
    resolution: "10m (S2) / 30m (Landsat) → 500m export",
    calculation: "NDVI = (NIR − RED) / (NIR + RED)",
    calcSteps: [
      "S2 images filtered: ±7 days around week, cloud% < 70",
      "Sorted by CLOUDY_PIXEL_PERCENTAGE → best real mosaic (no averaging)",
      "NIR = B8 (842nm), RED = B4 (665nm) for Sentinel-2",
      "Landsat 9/8: SR_B5/SR_B4; LS7: SR_B4/SR_B3",
      "Priority chain: S2 → LS9 → LS8 → LS7 via .unmask()",
      "NODATA = −9999; valid range: −1 to +1",
    ],
    unit: "Dimensionless index (−1 to +1)",
    valueRanges: [
      { range: "< 0.0",       meaning: "Water, barren land, urban surfaces",    color: "#7f1d1d" },
      { range: "0.0 – 0.15",  meaning: "Sparse vegetation, bare soil",          color: "#b45309" },
      { range: "0.15 – 0.30", meaning: "Degraded/dry vegetation, fallow land",  color: "#ca8a04" },
      { range: "0.30 – 0.50", meaning: "Moderate vegetation, growing crops",    color: "#65a30d" },
      { range: "0.50 – 0.70", meaning: "Dense vegetation, healthy crops",       color: "#16a34a" },
      { range: "> 0.70",      meaning: "Very dense forest / peak crop season",  color: "#14532d" },
    ],
    chartExplain: "% bar shows area with NDVI > 0.3 (moderate-to-dense vegetation). Nagpur peaks in monsoon (Jul–Sep) and Rabi season (Jan–Mar).",
    notes: "Nagpur is known for orange orchards (Vidarbha region). NDVI peaks in monsoon when forests and crops are fully green. Summer (Apr–Jun) shows steep decline.",
  },
  lulc: {
    title: "LULC — Land Use / Land Cover Classification",
    emoji: "🗺", accentColor: "#7c3aed", bgColor: "#f5f3ff",
    source: "Google Dynamic World V1 (2016+) + ESA WorldCover v200 (2015)",
    sourceShort: "Dynamic World",
    dataset: "GOOGLE/DYNAMICWORLD/V1 · ESA/WorldCover/v200",
    resolution: "10m Dynamic World → 500m export",
    calculation: "mode() of Dynamic World labels for the week",
    calcSteps: [
      "Dynamic World filtered by bounds + week date range",
      "Band 'label' (0–8 class integer) selected",
      ".mode() → most frequent real class for the week",
      "For 2015: ESA WorldCover v200 remapped to 0–8 classes",
      "NODATA filled with class 7 (Bare) via .unmask(7)",
    ],
    unit: "Discrete class integer (0–8)",
    valueRanges: LULC_CLASSES.map(c => ({ range: c.label, meaning: c.label.split(" ").slice(1).join(" "), color: c.color })),
    chartExplain: "LULC shows land cover class per pixel. Nagpur is predominantly agricultural with forested areas in the east near Pench/Tadoba.",
    notes: "Nagpur has Vidarbha cotton belt agriculture, city core (built-up), and forested areas. Dynamic World provides near-weekly updates.",
  },
  water: {
    title: "Water Cover — Surface Water Occurrence",
    emoji: "💧", accentColor: "#0891b2", bgColor: "#ecfeff",
    source: "JRC Global Surface Water v1.4 — Monthly History + Permanent Water",
    sourceShort: "JRC Surface Water",
    dataset: "JRC/GSW1_4/MonthlyHistory · JRC/GSW1_4/GlobalSurfaceWater",
    resolution: "30m JRC → 500m export",
    calculation: "Water % = closest monthly image remapped (water=100%, else 0)",
    calcSteps: [
      "JRC MonthlyHistory: closest month to week (±31 days)",
      "Pixel values: 0=no water, 1=water, 2=no data",
      "Remapped: water(1)→100%, no water(0)→0%, no data→0%",
      "Permanent occurrence layer fills where monthly = 0",
      "Final range: 0–100% water presence",
    ],
    unit: "% water presence (0–100)",
    valueRanges: [
      { range: "0%",        meaning: "No surface water",                 color: "#e0f2fe" },
      { range: "1 – 20%",   meaning: "Seasonal/episodic water bodies",   color: "#7dd3fc" },
      { range: "20 – 50%",  meaning: "Seasonal wetlands, river margins", color: "#38bdf8" },
      { range: "50 – 80%",  meaning: "Semi-permanent water bodies",      color: "#0284c7" },
      { range: "80 – 100%", meaning: "Permanent water — lakes, rivers",  color: "#1d4ed8" },
    ],
    chartExplain: "% bar = area with >20% water presence. Nagpur's reservoirs (Gorewada, Ambazari) and rivers fill post-monsoon (Sep–Oct).",
    notes: "Nagpur has several reservoirs and is near Kanhan & Pench rivers. Surface water peaks post-monsoon and drops in summer.",
  },
  lst: {
    title: "LST — Land Surface Temperature",
    emoji: "🌡", accentColor: "#ea580c", bgColor: "#fff7ed",
    source: "MODIS Terra+Aqua Day+Night mosaic + 8-day composites + ERA5-Land fill",
    sourceShort: "MODIS + ERA5",
    dataset: "MODIS/061/MOD11A1 · MODIS/061/MYD11A1 · MODIS/061/MOD11A2 · MODIS/061/MYD11A2 · ECMWF/ERA5_LAND",
    resolution: "1km MODIS → 500m export",
    calculation: "LST °C = raw × 0.02 − 273.15  (mosaic, no averaging)",
    calcSteps: [
      "Terra Day LST_Day_1km (MOD11A1): × 0.02 − 273.15",
      "Terra Night, Aqua Day, Aqua Night merged",
      "8-day composites (MOD11A2/MYD11A2) as fallback",
      "mosaic() = first valid real pixel, NO averaging",
      "ERA5 temperature_2m − 273.15 fills only fully masked pixels",
      "NODATA = −9999; valid range: ~5–55°C for Nagpur",
    ],
    unit: "Degrees Celsius (°C)",
    valueRanges: [
      { range: "< 10°C",    meaning: "Very cool — rare Nagpur winter nights",       color: "#1d4ed8" },
      { range: "10 – 20°C", meaning: "Cool — Dec–Jan morning temperatures",         color: "#38bdf8" },
      { range: "20 – 30°C", meaning: "Moderate — Spring/Autumn transition",         color: "#86efac" },
      { range: "30 – 40°C", meaning: "Warm — Pre-monsoon, urban heat",              color: "#facc15" },
      { range: "40 – 48°C", meaning: "Hot — May–Jun peak; Nagpur known for 45°C+",  color: "#f97316" },
      { range: "> 48°C",    meaning: "Extreme heat — rare peak summer days",        color: "#dc2626" },
    ],
    chartExplain: "Hot Zones % = pixels where LST > (avg + 5°C). Moderate = within ±5°C. Cool = below (avg − 5°C). Nagpur is one of India's hottest cities.",
    notes: "Nagpur ('Orange City') regularly records some of India's highest temperatures. Urban heat island effect is strong. Forest areas near Pench stay 5–8°C cooler.",
  },
  rain: {
    title: "Rainfall — Weekly Precipitation Total",
    emoji: "🌧", accentColor: "#0284c7", bgColor: "#f0f9ff",
    source: "CHIRPS Daily — Climate Hazards Group InfraRed Precipitation with Station data",
    sourceShort: "CHIRPS Daily",
    dataset: "UCSB-CHG/CHIRPS/DAILY · Google Earth Engine",
    resolution: "~5km native → 500m export",
    calculation: "Weekly Rain (mm) = sum of daily CHIRPS for the 7-day window",
    calcSteps: [
      "CHIRPS Daily filtered: bounds + 7-day window (t0 → t1)",
      "Band 'precipitation' (mm/day) selected",
      ".sum() across 7 daily images = real weekly total",
      "Missing pixels filled with 0.0 via .unmask(0.0)",
    ],
    unit: "Millimetres (mm) — weekly total",
    valueRanges: [
      { range: "0 mm",         meaning: "No rain — dry week",                  color: "#e0f2fe" },
      { range: "0.1 – 10 mm",  meaning: "Trace/light weekly total",            color: "#7dd3fc" },
      { range: "10 – 30 mm",   meaning: "Moderate rain week",                  color: "#38bdf8" },
      { range: "30 – 60 mm",   meaning: "Heavy rain — active monsoon week",    color: "#0284c7" },
      { range: "60 – 120 mm",  meaning: "Very heavy — intense monsoon event",  color: "#1d4ed8" },
      { range: "> 120 mm",     meaning: "Extreme — flood-risk level",          color: "#1e3a8a" },
    ],
    chartExplain: "% bar = area that received >20mm that week. Nagpur receives ~1,100mm annually, mostly Jun–Sep.",
    notes: "Nagpur lies in Vidarbha, known for erratic monsoon with intense rainfall events. Normal onset: ~15 June. Peak: July–August.",
  },
  soil: {
    title: "Soil Moisture — Relative Water Content",
    emoji: "🌱", accentColor: "#65a30d", bgColor: "#f7fee7",
    source: "TerraClimate — University of Idaho Monthly Climate Dataset",
    sourceShort: "TerraClimate",
    dataset: "IDAHO_EPSCOR/TERRACLIMATE · Google Earth Engine",
    resolution: "~4km native → 500m export",
    calculation: "Soil Fraction = closest monthly value ÷ 500 (no averaging)",
    calcSteps: [
      "TerraClimate filtered: ±2 months around week",
      "Band 'soil' (plant extractable water content, mm)",
      ".first() of sorted-by-time collection = closest real month",
      "Divided by 500 to normalize to 0–1 fraction",
      "Clamped: max(0.0).min(1.0); missing filled with 0.0",
    ],
    unit: "Fraction 0–1 (0% = completely dry, 100% = field capacity)",
    valueRanges: [
      { range: "0 – 0.10",    meaning: "Very dry — Nagpur summer drought stress", color: "#fde047" },
      { range: "0.10 – 0.25", meaning: "Dry — pre-monsoon / post-harvest",        color: "#a3e635" },
      { range: "0.25 – 0.45", meaning: "Moderate — adequate for crops",           color: "#84cc16" },
      { range: "0.45 – 0.65", meaning: "Moist — active monsoon / irrigation",     color: "#4ade80" },
      { range: "0.65 – 0.80", meaning: "Wet — post-monsoon saturated soil",       color: "#16a34a" },
      { range: "> 0.80",      meaning: "Saturated — waterlogged risk",            color: "#166534" },
    ],
    chartExplain: "% bar = area with soil moisture > 0.3 (30% field capacity). TerraClimate is monthly so values change smoothly week to week.",
    notes: "Nagpur's black cotton soil (Vertisols) has high water retention. Stays dry Apr–Jun, peaks Sep–Oct post-monsoon.",
  },
};

// ─── Stats resolver: TIFF-first, loading placeholder if TIFF not ready ────────
// Returns real TIFF pixel stats when cache is loaded, otherwise a loading state.

function getWeekStats(layer: LayerType, weekIndex: number): RealStats {
  const tiff = getTiffStats(layer, weekIndex);
  if (tiff) {
    return { ...tiff, tiffDerived: true };
  }
  // TIFF not loaded yet — return zeros so UI renders without crashing
  return { avg: 0, min: 0, max: 0, hotPct: 0, modPct: 100, coolPct: 0, count: 0, tiffDerived: false };
}

// Annual means: computed from all 52 TIFF bands per layer, or null if not loaded
function computeAnnualMeans(): AnnualMeans {
  const tiff = getTiffAnnualMeans();
  if (tiff) return tiff;
  return { ndvi: 0, lst: 0, rain: 0, soil: 0, water: 0 };
}

// ─── Canvas Dense TIFF-Pixel Heatmap Overlay ─────────────────────────────────
// Renders REAL TIFF pixel values as a dense, colourised heatmap — matching the
// old dashboard's immersive raster appearance.
//
// VISUAL ONLY — all analytics / tooltips continue to use TIFF-derived values.
//
// Architecture:
//   • PNG XYZ tiles  → base performance rendering (unchanged)
//   • This canvas   → dense TIFF-pixel visual overlay (upgraded)
//   • COG TIFF      → analytics + tooltips (unchanged)
//
// Rendering rules (from spec):
//   1. Read REAL pixel values from active TIFF band for the current week
//   2. Map values → RGBA using per-layer colour ramps
//   3. Skip invalid pixels (NaN / nodata) → stay transparent
//   4. Apply Gaussian-style alpha via a 3×3 box blur pass
//   5. Feather edges (distance-to-edge fade)
//   6. Cache rendered ImageBitmap per (layer, week)
//   7. Re-render only on: layer change, week change, map zoomend/moveend
//   8. Debounce re-render (200ms) — NEVER repaint during drag/pan

// Map viewport bounds and tooltip sampling area.
// Heatmap overlay uses actual TIFF bbox (from cache) to avoid geographic cutting.
const NAGPUR_BBOX = { minLat: 20.70, maxLat: 21.58, minLng: 78.65, maxLng: 79.70 };

// ── Absolute Temperature Color Scale for LST ─────────────────────────────────
// Designed for Nagpur's actual range (Jan ~19–32°C, May ~35–48°C):
//   ≤ 10°C  → Deep Blue
//   10–15°C → Blue → Cyan
//   15–20°C → Cyan → Lime Green
//   20–25°C → Lime Green → Yellow-Green
//   25–30°C → Yellow-Green → Yellow → Orange-Yellow
//   30–36°C → Orange-Yellow → Orange
//   36–42°C → Orange → Red-Orange
//   > 42°C  → Deep Red
function getLSTColor(temp: number): [number, number, number] {
  if (temp <= 10) return [0, 0, 200];
  if (temp <= 15) {
    const t = (temp - 10) / 5;
    return [0, Math.round(100 + t * 155), Math.round(200 - t * 50)];  // Blue → Cyan
  }
  if (temp <= 20) {
    const t = (temp - 15) / 5;
    return [Math.round(t * 80), Math.round(255), Math.round(150 - t * 150)]; // Cyan → Lime
  }
  if (temp <= 25) {
    const t = (temp - 20) / 5;
    return [Math.round(80 + t * 175), 255, 0]; // Lime → Yellow
  }
  if (temp <= 30) {
    const t = (temp - 25) / 5;
    return [255, Math.round(255 - t * 90), 0]; // Yellow → Orange-Yellow
  }
  if (temp <= 36) {
    const t = (temp - 30) / 6;
    return [255, Math.round(165 - t * 100), 0]; // Orange-Yellow → Orange
  }
  if (temp <= 42) {
    const t = (temp - 36) / 6;
    return [255, Math.round(65 - t * 65), 0]; // Orange → Red
  }
  return [200, 0, 0]; // Deep Red
}

// ── Per-layer colour ramps (kept for non-LST) ────────────────────────────────
function lerpColour(c1: [number,number,number], c2: [number,number,number], t: number): [number,number,number] {
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * t),
    Math.round(c1[1] + (c2[1] - c1[1]) * t),
    Math.round(c1[2] + (c2[2] - c1[2]) * t),
  ];
}

function sampleRamp(stops: [number, [number,number,number]][], t: number): [number,number,number] {
  t = Math.max(0, Math.min(1, t));
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const lo = stops[i-1], hi = stops[i];
      const tt = (t - lo[0]) / (hi[0] - lo[0]);
      return lerpColour(lo[1], hi[1], tt);
    }
  }
  return stops[stops.length - 1][1];
}

// NDVI, Rain, etc. ramps (unchanged)
const NDVI_RAMP: [number,[number,number,number]][] = [
  [0.00, [127, 29, 29]],
  [0.30, [161, 98, 7]],
  [0.50, [253,224,71]],
  [0.70, [101,163,13]],
  [1.00, [20,  83, 45]],
];

const RAIN_RAMP: [number,[number,number,number]][] = [
  [0.00, [224,242,254]],
  [0.30, [125,211,252]],
  [0.60, [56, 189,248]],
  [0.80, [2, 132,199]],
  [1.00, [30,  58,138]],
];

const SOIL_RAMP: [number,[number,number,number]][] = [
  [0.00, [253,224, 71]],
  [0.35, [163,230, 53]],
  [0.65, [132,204, 22]],
  [1.00, [22, 101, 52]],
];

const WATER_RAMP: [number,[number,number,number]][] = [
  [0.00, [224,242,254]],
  [0.30, [125,211,252]],
  [0.70, [56, 189,248]],
  [1.00, [29,  78,216]],
];

const LULC_COLOURS: [number,number,number][] = [
  [29, 78,216],   // 0 Water
  [21,128, 61],   // 1 Trees
  [134,239,172],  // 2 Grass
  [103,232,249],  // 3 Flooded
  [202,138,  4],  // 4 Crops
  [132,204, 22],  // 5 Shrub
  [249,115, 22],  // 6 Built
  [161, 98,  7],  // 7 Bare
  [224,242,254],  // 8 Snow/Ice
];

interface LayerValueRange {
  min: number;
  max: number;
}

const LAYER_VALUE_RANGES: Record<LayerType, LayerValueRange> = {
  lst:   { min: 8,   max: 50  },   // °C
  ndvi:  { min: -0.1, max: 0.85},
  rain:  { min: 0,   max: 120 },   // mm/wk
  soil:  { min: 0,   max: 1   },   // fraction
  water: { min: 0,   max: 100 },   // %
  lulc:  { min: 0,   max: 8   },   // class
};

function valueToRGBA(layer: LayerType, v: number): [number,number,number,number] {
  if (layer === "lst") {
    const [r, g, b] = getLSTColor(v);
    return [r, g, b, 220]; // Slightly higher opacity for visibility
  }

  if (layer === "lulc") {
    const cls = Math.max(0, Math.min(8, Math.round(v)));
    const [r,g,b] = LULC_COLOURS[cls] ?? [160,160,160];
    return [r, g, b, 210];
  }

  const range = LAYER_VALUE_RANGES[layer];
  const t = (v - range.min) / (range.max - range.min);

  let rgb: [number,number,number];
  switch (layer) {
    case "ndvi":  rgb = sampleRamp(NDVI_RAMP,  t); break;
    case "rain":  rgb = sampleRamp(RAIN_RAMP,  t); break;
    case "soil":  rgb = sampleRamp(SOIL_RAMP,  t); break;
    case "water": rgb = sampleRamp(WATER_RAMP, t); break;
    default:      rgb = [160,160,160];
  }
  return [...rgb, 210] as [number,number,number,number];
}

// 3x3 box blur — sparse-region safe.
// RULE: if a pixel is valid (alpha > 0) but ALL neighbours are transparent,
// preserve the original pixel exactly rather than wiping it to 0.
// This prevents isolated finite TIFF pixels disappearing in the blur pass.
function boxBlur(data: Uint8ClampedArray, W: number, H: number): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(data.length) as Uint8ClampedArray<ArrayBuffer>;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i4 = (y * W + x) * 4;
      let r=0,g=0,b=0,a=0, n=0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x+dx, ny = y+dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          const i = (ny*W+nx)*4;
          if (data[i+3] === 0) continue; // skip transparent neighbours
          r += data[i]; g += data[i+1]; b += data[i+2]; a += data[i+3]; n++;
        }
      }
      if (n === 0) {
        // No valid neighbours — if this pixel itself is valid, preserve it exactly
        if (data[i4+3] > 0) {
          out[i4] = data[i4]; out[i4+1] = data[i4+1];
          out[i4+2] = data[i4+2]; out[i4+3] = data[i4+3];
        }
        continue;
      }
      out[i4] = r/n; out[i4+1] = g/n; out[i4+2] = b/n; out[i4+3] = a/n;
    }
  }
  return out;
}

// Rendered frame cache — keyed by "year:layer:weekIndex"
const HEATMAP_CACHE = new Map<string, string>(); // key → dataURL
let HEATMAP_CACHE_YEAR = DEFAULT_YEAR; // track which year cache belongs to

// Clear cache when TIFF loads (called after detectAndLogScales)
function clearHeatmapCache() {
  HEATMAP_CACHE.clear();
  HEATMAP_CACHE_YEAR = _ACTIVE_YEAR;
}

function renderHeatmapToDataUrl(layer: LayerType, weekIndex: number): string | null {
  if (!TIFF_CACHE) return null;

  // If cache belongs to a different year, clear it
  if (HEATMAP_CACHE_YEAR !== _ACTIVE_YEAR) {
    HEATMAP_CACHE.clear();
    HEATMAP_CACHE_YEAR = _ACTIVE_YEAR;
  }

  const cacheKey = `${_ACTIVE_YEAR}:${layer}:${weekIndex}`;
  if (HEATMAP_CACHE.has(cacheKey)) return HEATMAP_CACHE.get(cacheKey)!;

  const { bands, width: tw, height: th, bbox: tiffBbox, nodata } = TIFF_CACHE;

  const bandIndex = getBandIndex(layer, weekIndex);
  if (bandIndex < 0 || bandIndex >= bands.length) return null;
  const band = bands[bandIndex];
  const scale = DETECTED_SCALE[layer];

  // Use actual TIFF bbox for the overlay so no data is cut off.
  // Overlay covers the full TIFF extent — Leaflet clips to visible map area automatically.
  const [tiffMinXFull, tiffMinYFull, tiffMaxXFull, tiffMaxYFull] = tiffBbox;
  const overlayMinLng = tiffMinXFull;
  const overlayMaxLng = tiffMaxXFull;
  const overlayMinLat = tiffMinYFull;
  const overlayMaxLat = tiffMaxYFull;

  const tiffLngSpan    = tiffMaxXFull - tiffMinXFull;
  const tiffLatSpan    = tiffMaxYFull - tiffMinYFull;
  const overlayLngSpan = overlayMaxLng - overlayMinLng;
  const overlayLatSpan = overlayMaxLat - overlayMinLat;

  const tiffPpd_x = tw / tiffLngSpan;
  const tiffPpd_y = th / tiffLatSpan;

  const W_raw = Math.round(overlayLngSpan * tiffPpd_x);
  const H_raw = Math.round(overlayLatSpan * tiffPpd_y);
  const UPSCALE = 1; // No upscale for nearest-neighbor crispness
  const W = Math.max(1, W_raw * UPSCALE);
  const H = Math.max(1, H_raw * UPSCALE);

  console.log(`[Heatmap ${layer} wk${weekIndex}] Render: Canvas=${W}x${H}`);

  const imgData = new Uint8ClampedArray(W * H * 4);
  let finitePixelCount = 0;

  for (let cy = 0; cy < H; cy++) {
    const lat = overlayMaxLat - (cy / H) * overlayLatSpan;
    for (let cx = 0; cx < W; cx++) {
      const lng = overlayMinLng + (cx / W) * overlayLngSpan;

      const tx = Math.floor(((lng - tiffMinXFull) / tiffLngSpan) * tw);
      const ty = Math.floor(((tiffMaxYFull - lat)  / tiffLatSpan) * th);

      if (tx < 0 || tx >= tw || ty < 0 || ty >= th) continue;

      const ti  = ty * tw + tx;
      const raw = (band as any)[ti] as number;

      // STRICT NODATA FILTER
      if (!Number.isFinite(raw) || raw === -9999 || (nodata !== null && raw === nodata)) {
        continue;
      }

      const v = raw * scale;
      if (!Number.isFinite(v)) continue;

      const [r, g, b, a] = valueToRGBA(layer, v);
      const i4 = (cy * W + cx) * 4;
      imgData[i4]   = r;
      imgData[i4+1] = g;
      imgData[i4+2] = b;
      imgData[i4+3] = a;
      finitePixelCount++;
    }
  }

  // ── Save strict mask BEFORE any alpha modification ────────────────────────
  const hasData = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (imgData[i * 4 + 3] > 0) hasData[i] = 1;
  }

  // Minimal feathering only on boundaries
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i4 = (y * W + x) * 4;
      if (imgData[i4+3] === 0) continue;

      let transparentN = 0, totalN = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x+dx, ny = y+dy;
          if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
          totalN++;
          if (imgData[(ny*W+nx)*4+3] === 0) transparentN++;
        }
      }
      if (transparentN === 0) continue;
      const feather  = 1.0 - (transparentN / totalN) * 0.35;
      imgData[i4+3]  = Math.round(imgData[i4+3] * feather);
    }
  }

  const blurred = boxBlur(imgData, W, H);

  // STRICT MASK ENFORCEMENT — no bleed
  for (let i = 0; i < W * H; i++) {
    if (!hasData[i]) {
      blurred[i * 4]     = 0;
      blurred[i * 4 + 1] = 0;
      blurred[i * 4 + 2] = 0;
      blurred[i * 4 + 3] = 0;
    }
  }

  console.log(`[Heatmap ${layer} wk${weekIndex}] Finite pixels: ${finitePixelCount}`);

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false; // CRITICAL: nearest-neighbor

  const imageData = new ImageData(blurred as Uint8ClampedArray<ArrayBuffer>, W, H);
  ctx.putImageData(imageData, 0, 0);

  const dataUrl = canvas.toDataURL("image/png");
  HEATMAP_CACHE.set(cacheKey, dataUrl);
  return dataUrl;
}

const CanvasHeatmapLayer = React.memo(({ activeLayer, weekIndex }: {
  activeLayer: LayerType; weekIndex: number; year: number;
}) => {
  const map        = useMap();
  const overlayRef = useRef<L.ImageOverlay | null>(null);
  const debounceRef= useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<boolean>(false);
  const isDragging = useRef(false);

  const getBoundsFromTiff = useCallback((): L.LatLngBoundsExpression => {
    if (TIFF_CACHE) {
      const [minX, minY, maxX, maxY] = TIFF_CACHE.bbox;
      return [[minY, minX], [maxY, maxX]];
    }
    return [
      [NAGPUR_BBOX.minLat, NAGPUR_BBOX.minLng],
      [NAGPUR_BBOX.maxLat, NAGPUR_BBOX.maxLng],
    ];
  }, []);

  const applyOverlay = useCallback((dataUrl: string) => {
    const activeBounds = getBoundsFromTiff();
    if (overlayRef.current) {
      overlayRef.current.setUrl(dataUrl);
      overlayRef.current.setBounds(L.latLngBounds(activeBounds as L.LatLngBoundsLiteral));
      overlayRef.current.setOpacity(0.85);
    } else {
      const overlay = L.imageOverlay(dataUrl, activeBounds, {
        opacity: 0.85,
        zIndex: 200,
        interactive: false,
        className: "nagpur-heat-overlay",
      });
      overlay.addTo(map);
      overlayRef.current = overlay;
    }
  }, [map, getBoundsFromTiff]);

  const scheduleRender = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (isDragging.current) { pendingRef.current = true; return; }
      requestAnimationFrame(() => {
        if (!TIFF_CACHE) return; // CRITICAL: Only render after TIFF loaded
        const dataUrl = renderHeatmapToDataUrl(activeLayer, weekIndex);
        if (dataUrl) {
          applyOverlay(dataUrl);
        }
      });
    }, 180);
  }, [activeLayer, weekIndex, applyOverlay]);

  // Re-render on layer/week change ONLY if TIFF ready
  useEffect(() => {
    if (TIFF_CACHE) scheduleRender();
  }, [scheduleRender]);

  useEffect(() => {
    const onDragStart = () => { isDragging.current = true; };
    const onDragEnd   = () => {
      isDragging.current = false;
      if (pendingRef.current) { pendingRef.current = false; scheduleRender(); }
    };
    const onSettled   = () => { if (!isDragging.current && TIFF_CACHE) scheduleRender(); };

    map.on("dragstart",  onDragStart);
    map.on("dragend",    onDragEnd);
    map.on("zoomend",    onSettled);
    map.on("moveend",    onSettled);

    return () => {
      map.off("dragstart", onDragStart);
      map.off("dragend",   onDragEnd);
      map.off("zoomend",   onSettled);
      map.off("moveend",   onSettled);
    };
  }, [map, scheduleRender]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (overlayRef.current) {
        map.removeLayer(overlayRef.current);
        overlayRef.current = null;
      }
    };
  }, [map]);

  return null;
});

// ─── Card ─────────────────────────────────────────────────────────────────────

function Card({ children, style = {} }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, boxShadow: "0 2px 12px rgba(0,0,0,0.06)", ...style }}>
      {children}
    </div>
  );
}

function SummaryGrid({ items }: {
  items: { label: string; value: string; accent: string; bg: string; icon: React.ElementType }[];
}) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: items.length > 2 ? "1fr 1fr" : "1fr", gap: 8 }}>
      {items.map(({ label, value, accent, bg, icon: Icon }) => (
        <Card key={label} style={{ padding: "10px 12px", background: bg }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <Icon size={11} color={accent} />
            <span style={{ fontSize: 9.5, color: accent, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
          </div>
          <p style={{ fontSize: 15, fontWeight: 800, color: "#111827", fontFamily: "monospace" }}>{value}</p>
        </Card>
      ))}
    </div>
  );
}

// ─── Annual Means Panel ───────────────────────────────────────────────────────

function AnnualMeansPanel({ means, year }: { means: AnnualMeans; year: number }) {
  const loaded = means.lst > 0 || means.ndvi > 0;
  const rows = [
    { label: "🌿 NDVI",         value: loaded ? means.ndvi.toFixed(3) : "—",                           note: "avg greenness", color: "#16a34a", bg: "#f0fdf4" },
    { label: "🌡️ Temperature",  value: loaded ? `${means.lst.toFixed(1)} °C` : "—",                     note: "avg LST",       color: "#ea580c", bg: "#fff7ed" },
    { label: "🌧️ Rain",         value: loaded ? `${means.rain.toFixed(1)} mm/wk` : "—",                 note: "avg weekly",    color: "#0284c7", bg: "#f0f9ff" },
    { label: "🌱 Soil Moisture", value: SOIL_DATA_UNRELIABLE ? "⚠️ Unreliable" : (loaded ? `${(means.soil*100).toFixed(1)} %` : "—"),              note: SOIL_DATA_UNRELIABLE ? "source corrupted" : "avg fraction",  color: SOIL_DATA_UNRELIABLE ? "#dc2626" : "#65a30d", bg: SOIL_DATA_UNRELIABLE ? "#fef2f2" : "#f7fee7" },
    { label: "💧 Water Cover",   value: loaded ? `${means.water.toFixed(1)} %` : "—",                   note: "avg water",     color: "#0891b2", bg: "#ecfeff" },
  ];
  return (
    <Card style={{ padding: "14px 16px" }}>
      <p style={sectionLabel}>{year} Annual Means · Real Climatology</p>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {rows.map(r => (
          <div key={r.label} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: r.bg, borderRadius: 9, padding: "7px 10px" }}>
            <div>
              <span style={{ fontSize: 11, fontWeight: 700, color: "#111827" }}>{r.label}</span>
              <span style={{ fontSize: 9.5, color: "#9ca3af", marginLeft: 5 }}>{r.note}</span>
            </div>
            <span style={{ fontSize: 13, fontWeight: 800, color: r.color, fontFamily: "monospace" }}>{r.value}</span>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 8, padding: "5px 8px", background: "#f0fdf4", borderRadius: 7, border: "1px solid #bbf7d0" }}>
        <span style={{ fontSize: 9, color: "#15803d", fontWeight: 600 }}>
          Source: COG TIFF Band Means · All 52 Weeks · Real Pixels
        </span>
      </div>
    </Card>
  );
}

// ─── Data Sources Panel ───────────────────────────────────────────────────────

function DataSourcesPanel({ year }: { year: number }) {
  return (
    <Card style={{ padding: "14px 16px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <Database size={12} color="#7c3aed" />
        <p style={{ ...sectionLabel, marginBottom: 0, color: "#7c3aed" }}>Data Sources · GEE</p>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {DATA_SOURCES.map(s => (
          <div key={s.label} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "6px 8px", background: "#fafafa", borderRadius: 8, border: "1px solid #f1f5f9" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.dot, flexShrink: 0, marginTop: 3, display: "inline-block" }} />
            <div>
              <span style={{ fontSize: 10.5, fontWeight: 700, color: "#374151", display: "block" }}>{s.label}</span>
              <span style={{ fontSize: 9.5, color: "#9ca3af" }}>{s.value}</span>
            </div>
          </div>
        ))}
        <div style={{ marginTop: 4, padding: "5px 8px", background: "#f5f3ff", borderRadius: 7, border: "1px solid #ede9fe" }}>
          <span style={{ fontSize: 9, color: "#7c3aed", fontWeight: 600 }}>Scale: 500m · CRS: EPSG:4326</span><br />
          <span style={{ fontSize: 9, color: "#9ca3af" }}>Tiles: XYZ PNG · public/tiles/{year}/{"{z}/{x}/{y}"}.png</span>
        </div>
      </div>
    </Card>
  );
}

// ─── Info Tab ─────────────────────────────────────────────────────────────────

function InfoTab({ activeLayer, onClose }: { activeLayer: LayerType; onClose: () => void }) {
  const info = LAYER_INFO[activeLayer];
  return (
    <div style={{
      position: "absolute", top: 0, left: 0, width: 340, height: "100vh",
      background: "#fff", borderRight: "1px solid #e5e7eb",
      boxShadow: "4px 0 24px rgba(0,0,0,0.10)", zIndex: 800,
      display: "flex", flexDirection: "column", overflow: "hidden",
    }}>
      <div style={{ padding: "14px 14px 10px", borderBottom: "1px solid #e5e7eb", background: info.bgColor, flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 5 }}>
              <span style={{ fontSize: 22, lineHeight: 1 }}>{info.emoji}</span>
              <div style={{ fontSize: 15, fontWeight: 800, color: "#111827", lineHeight: 1.3 }}>{info.title}</div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
              <span style={{ fontSize: 11, fontWeight: 700, background: info.accentColor, color: "#fff", borderRadius: 6, padding: "3px 8px" }}>{info.sourceShort}</span>
              <span style={{ fontSize: 11, fontWeight: 600, background: "#f5f3ff", color: "#7c3aed", borderRadius: 6, padding: "3px 8px" }}>{info.resolution}</span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: "#f1f5f9", border: "none", borderRadius: 8, width: 28, height: 28, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginLeft: 8 }}>
            <X size={14} color="#6b7280" />
          </button>
        </div>
      </div>
      <div className="info-scroll" style={{ flex: 1, overflowY: "auto", padding: "14px 14px 20px" }}>
        <div style={{ marginBottom: 14, padding: "10px 12px", background: "#fafafa", borderRadius: 10, border: "1px solid #e5e7eb" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>Dataset Source</div>
          <div style={{ fontSize: 12.5, fontWeight: 600, color: "#111827", lineHeight: 1.5 }}>{info.source}</div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4, fontFamily: "monospace" }}>{info.dataset}</div>
        </div>
        <div style={{ marginBottom: 14, padding: "10px 12px", background: `${info.accentColor}0d`, borderRadius: 10, border: `1px solid ${info.accentColor}22` }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: info.accentColor, textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>Calculation Formula</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#111827", fontFamily: "monospace", background: "#fff", borderRadius: 7, padding: "7px 10px", border: `1px solid ${info.accentColor}33` }}>{info.calculation}</div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 7 }}>Processing Steps (Google Earth Engine)</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {info.calcSteps.map((step, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", padding: "7px 10px", background: "#f8fafc", borderRadius: 8, border: "1px solid #f1f5f9" }}>
                <span style={{ fontSize: 11, fontWeight: 800, color: "#fff", background: info.accentColor, borderRadius: "50%", width: 20, height: 20, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 1 }}>{i+1}</span>
                <span style={{ fontSize: 12, color: "#374151", lineHeight: 1.5 }}>{step}</span>
              </div>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 14, padding: "8px 12px", background: "#f8fafc", borderRadius: 9, border: "1px solid #e5e7eb", display: "flex", alignItems: "center", gap: 8 }}>
          <ChevronRight size={14} color={info.accentColor} />
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em" }}>Unit</div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#111827" }}>{info.unit}</div>
          </div>
        </div>
        <div style={{ marginBottom: 14 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 7 }}>Value Ranges &amp; Meaning</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
            {info.valueRanges.map((vr, i) => (
              <div key={i} style={{ display: "flex", gap: 8, alignItems: "center", padding: "7px 10px", background: "#f8fafc", borderRadius: 8, border: "1px solid #f1f5f9" }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: vr.color, flexShrink: 0, display: "inline-block" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#111827", fontFamily: "monospace" }}>{vr.range}</span>
                  <span style={{ fontSize: 11.5, color: "#6b7280", marginLeft: 6 }}>— {vr.meaning}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div style={{ marginBottom: 14, padding: "10px 12px", background: "#fffbeb", borderRadius: 10, border: "1px solid #fde68a" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#92400e", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>📊 What does the % bar mean?</div>
          <div style={{ fontSize: 12, color: "#78350f", lineHeight: 1.6 }}>{info.chartExplain}</div>
        </div>
        <div style={{ padding: "10px 12px", background: "#f0f9ff", borderRadius: 10, border: "1px solid #bae6fd" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: "#0369a1", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 5 }}>📝 Field Notes — Nagpur</div>
          <div style={{ fontSize: 12, color: "#0c4a6e", lineHeight: 1.6 }}>{info.notes}</div>
        </div>
      </div>
    </div>
  );
}

// ─── Band Diagnostics Panel ───────────────────────────────────────────────────
// Shows raw TIFF band values for the current layer — pinpoints GEE export issues.
// Displays for all 4 probe weeks so you can see if values vary across time.

function BandDiagnosticsPanel({ activeLayer, weekIndex }: { activeLayer: LayerType; weekIndex: number }) {
  if (!TIFF_CACHE) return null;

  const PROBE_WEEKS = [0, 1, 10, 25];
  const rows = PROBE_WEEKS.map(wi => {
    const bi   = wi * 6 + BAND_OFFSETS[activeLayer];
    if (bi >= TIFF_CACHE!.bands.length) return { wi, bi, s: null };
    const band = TIFF_CACHE!.bands[bi];
    const s    = fullBandStats(band, TIFF_CACHE!.nodata);
    return { wi, bi, s };
  });

  const curBi   = weekIndex * 6 + BAND_OFFSETS[activeLayer];
  const curBand = curBi < TIFF_CACHE.bands.length ? TIFF_CACHE.bands[curBi] : null;
  const curRaw  = curBand ? fullBandStats(curBand, TIFF_CACHE.nodata) : null;
  const scale   = DETECTED_SCALE[activeLayer];

  const isDead = curRaw !== null && curRaw.count === 0;
  const isSaturated = !isDead && curRaw !== null &&
    curRaw.count > 0 &&
    Math.abs(curRaw.max - curRaw.min) < 0.003 &&
    curRaw.count > 50;

  const classifyRow = (s: ReturnType<typeof fullBandStats> | null): "dead" | "saturated" | "ok" | "missing" => {
    if (!s) return "missing";
    if (s.count === 0) return "dead";
    if (Math.abs(s.max - s.min) < 0.003 && s.count > 50) return "saturated";
    return "ok";
  };

  const diagKey = `${activeLayer}:26`;
  const diag    = BAND_DIAGNOSTICS.get(diagKey);

  const showSoilBanner = activeLayer === "soil" && SOIL_DATA_UNRELIABLE;

  return (
    <Card style={{ padding: "14px 16px", border: "1px solid #fcd34d", background: "#fffbeb" }}>
      <div style={{ display:"flex", alignItems:"center", gap:6, marginBottom:8 }}>
        <span style={{ fontSize:13 }}>🔬</span>
        <p style={{ ...sectionLabel, marginBottom:0, color:"#92400e" }}>Band Diagnostics · {LAYER_META[activeLayer].name}</p>
      </div>

      {showSoilBanner && (
        <div style={{ marginBottom:10, padding:"10px 12px", background:"#fef2f2", border:"2px solid #ef4444", borderRadius:8 }}>
          <div style={{ fontSize:11, fontWeight:800, color:"#991b1b", marginBottom:4 }}>
            ⛔ SOIL DATA UNRELIABLE — SOURCE TIFF CORRUPTED
          </div>
          <div style={{ display:"flex", flexDirection:"column", gap:3, marginBottom:6 }}>
            <span style={{ fontSize:9.5, color:"#7f1d1d" }}>• Some weeks: all pixels ≈ 1.0 (GEE .min(1) saturation)</span>
            <span style={{ fontSize:9.5, color:"#7f1d1d" }}>• Some weeks: all pixels = 0 (dead band / masked region)</span>
            <span style={{ fontSize:9.5, color:"#7f1d1d" }}>• Temporal pattern is inconsistent → data cannot be corrected</span>
          </div>
          <div style={{ padding:"6px 9px", background:"#fff7ed", borderRadius:6, border:"1px solid #fed7aa" }}>
            <div style={{ fontSize:9, fontWeight:700, color:"#9a3412", marginBottom:3 }}>Required GEE Re-export Fix:</div>
            <div style={{ fontSize:8.5, color:"#7c2d12", fontFamily:"monospace", lineHeight:1.7, whiteSpace:"pre-wrap" }}>
              {`// 1. Check actual raw range:\nsoil_img.reduceRegion(\n  ee.Reducer.minMax(), NAGPUR, 5000\n).evaluate(print)\n\n// 2. Use correct divisor (e.g. if max≈4000):\nsoil_normalized = soil_img.divide(4000)\n  .max(0).min(1)\n\n// 3. Ensure no temporal masking:\n.unmask(0).clip(NAGPUR)`}
            </div>
          </div>
          <div style={{ marginTop:5, fontSize:9, color:"#991b1b", fontWeight:600 }}>
            Frontend displays raw values honestly. No interpolation or correction applied.
          </div>
        </div>
      )}

      {curRaw && (
        <div style={{ marginBottom:10, padding:"8px 10px", background:"#fff", borderRadius:8, border:"1px solid #fde68a" }}>
          <div style={{ fontSize:9.5, fontWeight:700, color:"#78350f", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:6 }}>
            Current Week {weekIndex+1} · Band {curBi}
          </div>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:4 }}>
            {[
              { label:"RAW min",  val: curRaw.min.toFixed(4),   color:"#3b82f6" },
              { label:"RAW max",  val: curRaw.max.toFixed(4),   color:"#ef4444" },
              { label:"RAW avg",  val: curRaw.avg !== null ? curRaw.avg.toFixed(4) : "—", color:"#374151" },
              { label:"×scale",   val: `×${scale}`,              color:"#7c3aed" },
              { label:"DISP min", val: (curRaw.min * scale).toFixed(4), color:"#3b82f6" },
              { label:"DISP max", val: (curRaw.max * scale).toFixed(4), color:"#ef4444" },
            ].map(r => (
              <div key={r.label} style={{ background:"#f9fafb", borderRadius:5, padding:"4px 6px" }}>
                <div style={{ fontSize:7.5, color:"#9ca3af", fontWeight:700, textTransform:"uppercase" }}>{r.label}</div>
                <div style={{ fontSize:11, fontWeight:800, color:r.color, fontFamily:"monospace" }}>{r.val}</div>
              </div>
            ))}
          </div>
          {isDead && (
            <div style={{ marginTop:6, padding:"5px 8px", background:"#f1f5f9", border:"1px solid #94a3b8", borderRadius:6 }}>
              <span style={{ fontSize:9.5, color:"#1e3a5f", fontWeight:700 }}>
                ⬛ DEAD BAND: zero valid pixels this week.
              </span>
            </div>
          )}
          {isSaturated && !isDead && (
            <div style={{ marginTop:6, padding:"5px 8px", background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:6 }}>
              <span style={{ fontSize:9.5, color:"#991b1b", fontWeight:700 }}>
                ⚠️ SATURATED: all pixels ≈ same value.
              </span>
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize:9.5, fontWeight:700, color:"#78350f", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:5 }}>
        Raw TIFF Values · 4 Probe Weeks
      </div>
      <div style={{ display:"flex", flexDirection:"column", gap:3 }}>
        <div style={{ display:"grid", gridTemplateColumns:"40px 40px 40px 1fr 1fr 1fr", gap:4, padding:"3px 6px" }}>
          {["wk","band","state","min","max","avg"].map(h => (
            <span key={h} style={{ fontSize:8, color:"#9ca3af", fontWeight:700, textTransform:"uppercase" }}>{h}</span>
          ))}
        </div>
        {rows.map(({ wi, bi, s }) => {
          const state = classifyRow(s);
          const stateBg = state === "dead" ? "#f1f5f9" : state === "saturated" ? "#fef2f2" : "#fff";
          const stateBorder = state === "dead" ? "1px solid #94a3b8" : state === "saturated" ? "1px solid #fca5a5" : "1px solid #f1f5f9";
          const stateLabel = state === "dead" ? "⬛dead" : state === "saturated" ? "⚠️sat" : state === "missing" ? "❌miss" : "✓ok";
          const stateColor = state === "dead" ? "#475569" : state === "saturated" ? "#991b1b" : state === "missing" ? "#dc2626" : "#15803d";
          return (
            <div key={wi} style={{
              display:"grid", gridTemplateColumns:"40px 40px 40px 1fr 1fr 1fr", gap:4,
              padding:"4px 6px", borderRadius:6,
              background: wi === weekIndex ? "#fef3c7" : stateBg,
              border: wi === weekIndex ? "1px solid #fbbf24" : stateBorder,
            }}>
              <span style={{ fontSize:9, color:"#374151", fontFamily:"monospace" }}>W{wi+1}</span>
              <span style={{ fontSize:9, color:"#7c3aed", fontFamily:"monospace" }}>b{bi}</span>
              <span style={{ fontSize:8, color:stateColor, fontWeight:700 }}>{stateLabel}</span>
              {s && s.count > 0 ? (
                <>
                  <span style={{ fontSize:9, color:"#3b82f6", fontFamily:"monospace" }}>{s.min.toFixed(3)}</span>
                  <span style={{ fontSize:9, color:"#ef4444", fontFamily:"monospace" }}>{s.max.toFixed(3)}</span>
                  <span style={{ fontSize:9, color:"#374151", fontFamily:"monospace" }}>{s.avg !== null ? s.avg.toFixed(3) : "—"}</span>
                </>
              ) : (
                <span style={{ fontSize:9, color:"#ef4444", gridColumn:"4/7" }}>{s ? "no valid pixels" : "out of range"}</span>
              )}
            </div>
          );
        })}
      </div>

      {diag?.warning && !showSoilBanner && (
        <div style={{ marginTop:8, padding:"7px 9px", background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:7 }}>
          <div style={{ fontSize:9, fontWeight:700, color:"#991b1b", marginBottom:3 }}>⚠️ GEE Export Issue Detected</div>
          <div style={{ fontSize:9, color:"#7f1d1d", lineHeight:1.5 }}>{diag.warning}</div>
        </div>
      )}

      <div style={{ marginTop:7, fontSize:8, color:"#b45309" }}>
        Scale factor: ×{scale} applied to raw TIFF values.
      </div>
    </Card>
  );
}

function AnalyticsContent({ stats, activeLayer, weekIndex, year, annualMeans }: {
  stats: RealStats; activeLayer: LayerType; weekIndex: number; year: number; annualMeans: AnnualMeans;
}) {
  const isLoading = !stats.tiffDerived;

  const meta        = LAYER_META[activeLayer];
  const accentColor = LAYER_INFO[activeLayer].accentColor;
  const bgColor     = LAYER_INFO[activeLayer].bgColor;

  const d1      = dateFromWeek(year, weekIndex);
  const d2      = dateEndFromWeek(year, weekIndex);
  const dateStr = `${formatDateShort(d1)} – ${formatDateShort(d2)} ${year}`;

  const fmtVal = (v: number): string => {
    switch (activeLayer) {
      case "lst":   return `${v.toFixed(1)}°C`;
      case "ndvi":  return v.toFixed(3);
      case "rain":  return `${v.toFixed(1)} mm`;
      case "soil":  return `${v.toFixed(4)} (${(v * 100).toFixed(1)}%)`;
      case "water": return `${v.toFixed(2)}%`;
      case "lulc":  return `cls ${Math.round(v)}`;
      default:      return v.toFixed(4);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Card style={{ padding: "12px 14px", background: bgColor, border: `1px solid ${accentColor}33` }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom: 8 }}>
          <p style={{ ...sectionLabel, color: accentColor, marginBottom: 0 }}>{meta.emoji} {meta.name} · Active Layer</p>
          {activeLayer === "soil" && SOIL_DATA_UNRELIABLE
            ? <span style={{ fontSize:8, background:"#fef2f2", color:"#991b1b", borderRadius:4, padding:"1px 5px", fontWeight:700, border:"1px solid #fca5a5" }}>⚠️ UNRELIABLE</span>
            : isLoading
              ? <span style={{ fontSize:8, background:"#fef9c3", color:"#92400e", borderRadius:4, padding:"1px 5px", fontWeight:700 }}>TIFF Loading…</span>
              : <span style={{ fontSize:8, background:"#dcfce7", color:"#15803d", borderRadius:4, padding:"1px 5px", fontWeight:700 }}>COG TIFF ✓</span>
          }
        </div>
        {activeLayer === "soil" && SOIL_DATA_UNRELIABLE && (
          <div style={{ marginBottom:8, padding:"6px 10px", background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:7 }}>
            <span style={{ fontSize:9.5, color:"#7f1d1d", fontWeight:700 }}>
              Source TIFF temporally corrupt.
            </span>
          </div>
        )}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          {[
            { label: "Average", value: isLoading ? "—" : fmtVal(stats.avg), accent: accentColor },
            { label: "Pixels",  value: isLoading ? "—" : stats.count.toLocaleString(), accent: "#6b7280" },
            { label: "Min",     value: isLoading ? "—" : fmtVal(stats.min), accent: "#3b82f6" },
            { label: "Max",     value: isLoading ? "—" : fmtVal(stats.max), accent: "#dc2626" },
          ].map(r => (
            <div key={r.label} style={{ background: "#fff", borderRadius: 9, padding: "8px 10px", border: "1px solid #f1f5f9" }}>
              <div style={{ fontSize: 9, color: "#9ca3af", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 3 }}>{r.label}</div>
              <div style={{ fontSize: 14, fontWeight: 800, color: isLoading ? "#d1d5db" : r.accent, fontFamily: "monospace" }}>{r.value}</div>
            </div>
          ))}
        </div>
      </Card>

      {activeLayer === "lst" && (
        <>
          <SummaryGrid items={[
            { label: "Avg Temp",  value: `${stats.avg.toFixed(1)}°C`,   accent: "#f97316", bg: "#fff7ed", icon: Thermometer },
            { label: "Hot Zones", value: `${stats.hotPct.toFixed(1)}%`,  accent: "#dc2626", bg: "#fef2f2", icon: Activity    },
            { label: "Moderate",  value: `${stats.modPct.toFixed(1)}%`,  accent: "#ca8a04", bg: "#fefce8", icon: Activity    },
            { label: "Cool",      value: `${stats.coolPct.toFixed(1)}%`, accent: "#3b82f6", bg: "#eff6ff", icon: Activity    },
          ]} />
        </>
      )}

      <Card style={{ padding: "14px 16px" }}>
        <p style={sectionLabel}>Data Info · Week {weekIndex + 1}/52</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            { label: "Period",   value: dateStr },
            { label: "Pixels",   value: isLoading ? "Loading…" : stats.count.toLocaleString() },
            { label: "Min",      value: isLoading ? "—" : fmtVal(stats.min) },
            { label: "Max",      value: isLoading ? "—" : fmtVal(stats.max) },
            { label: "Average",  value: isLoading ? "—" : fmtVal(stats.avg) },
            { label: "Source",   value: isLoading ? "COG TIFF loading…" : "COG TIFF · Real Pixels" },
          ].map(r => (
            <div key={r.label} style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 10.5, color: "#6b7280" }}>{r.label}</span>
              <span style={{ fontSize: 10.5, color: isLoading && r.label !== "Period" ? "#d1d5db" : "#111827", fontWeight: 600, fontFamily: "monospace" }}>{r.value}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card style={{ padding: "14px 16px" }}>
        <p style={sectionLabel}>Layer Overview</p>
        {[
          { label: "NDVI",        pct: annualMeans.ndvi > 0 ? Math.round(Math.max(0, Math.min(100, (annualMeans.ndvi / 0.85) * 100))) : null, color: "#22c55e", explain: annualMeans.ndvi > 0 ? `Annual avg NDVI ${annualMeans.ndvi.toFixed(3)}` : "TIFF loading…" },
          { label: "LST Hot",     pct: stats.tiffDerived ? Math.min(100, Math.round(stats.hotPct + stats.modPct)) : null, color: "#f97316", explain: stats.tiffDerived ? `${Math.min(100, Math.round(stats.hotPct + stats.modPct))}% area is moderate-to-hot` : "TIFF loading…" },
          { label: "Rainfall",    pct: annualMeans.rain > 0 ? Math.round(Math.max(0, Math.min(100, (annualMeans.rain / 80) * 100))) : null,  color: "#38bdf8", explain: annualMeans.rain > 0 ? `Annual avg rain ${annualMeans.rain.toFixed(1)} mm/week` : "TIFF loading…" },
          { label: "Soil Moist.", pct: annualMeans.soil > 0 ? Math.round(Math.max(0, Math.min(100, annualMeans.soil * 100))) : null,         color: "#84cc16", explain: annualMeans.soil > 0 ? `Annual avg soil ${(annualMeans.soil * 100).toFixed(1)}%` : "TIFF loading…" },
          { label: "Water Cover", pct: annualMeans.water > 0 ? Math.round(Math.max(0, Math.min(100, annualMeans.water))) : null,              color: "#06b6d4", explain: annualMeans.water > 0 ? `Annual avg water ${annualMeans.water.toFixed(1)}%` : "TIFF loading…" },
        ].map(r => (
          <div key={r.label} style={{ marginBottom: 11 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
              <span style={{ fontSize: 11, color: "#475569", fontWeight: 600 }}>{r.label}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: r.pct !== null ? "#111827" : "#d1d5db" }}>{r.pct !== null ? `${r.pct}%` : "—"}</span>
            </div>
            <div style={{ height: 5, background: "#f1f5f9", borderRadius: 99, overflow: "hidden", marginBottom: 4 }}>
              <div style={{ height: "100%", width: r.pct !== null ? `${r.pct}%` : "0%", background: r.color, borderRadius: 99, transition: "width 0.6s" }} />
            </div>
            <div style={{ fontSize: 9.5, color: "#9ca3af", lineHeight: 1.4 }}>{r.explain}</div>
          </div>
        ))}
      </Card>

      <AnnualMeansPanel means={annualMeans} year={year} />
      <BandDiagnosticsPanel activeLayer={activeLayer} weekIndex={weekIndex} />
      <DataSourcesPanel year={year} />
    </div>
  );
}

// ─── Basemap Tiles ────────────────────────────────────────────────────────────

function BasemapTiles({ mapType }: { mapType: MapType }) {
  const labelsLayer = (
    <TileLayer
      key="city-labels"
      url="https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
      maxZoom={22}
      opacity={0.95}
      zIndex={450}
    />
  );
  if (mapType === "osm") {
    return (
      <>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
        {labelsLayer}
      </>
    );
  }
  if (mapType === "satellite") {
    return (
      <>
        <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" maxZoom={22} attribution="© Esri" />
        {labelsLayer}
      </>
    );
  }
  return (
    <>
      <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}" maxZoom={22} attribution="© Esri" />
      {labelsLayer}
    </>
  );
}

// ─── XYZ Raster Tile Layer ────────────────────────────────────────────────────

const RasterTileLayer = React.memo(({ year }: { year: number }) => {
  const tileUrl = getTileUrl(year);
  if (!tileUrl) return null;
  return (
    <TileLayer
      key={`raster-${year}`}
      url={tileUrl}
      attribution="Nagpur Raster Tiles"
      opacity={0.8}
      minZoom={5}
      maxZoom={12}
      tileSize={256}
      updateWhenZooming={false}
      updateWhenIdle={true}
      keepBuffer={6}
      crossOrigin={true}
      zIndex={250}
      className="nagpur-tiles"
    />
  );
});

// ─── Map Controls ─────────────────────────────────────────────────────────────

function MapControls({ mapType, setMapType }: { mapType: MapType; setMapType: (m: MapType) => void }) {
  const map = useMap();
  return (
    <div style={{ position: "absolute", top: 16, right: 16, zIndex: 700, display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.09)", overflow: "hidden" }}>
        {[{ label: "+", fn: () => map.zoomIn() }, { label: "−", fn: () => map.zoomOut() }].map(({ label, fn }) => (
          <button key={label} onClick={fn}
            style={{ display: "block", width: 36, height: 36, border: "none", background: "transparent", fontSize: 18, cursor: "pointer", color: "#374151", lineHeight: 1, borderBottom: label === "+" ? "1px solid #f1f5f9" : "none" }}
            onMouseEnter={e => (e.currentTarget.style.background = "#f8fafc")}
            onMouseLeave={e => (e.currentTarget.style.background = "transparent")}>{label}</button>
        ))}
      </div>
      <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.09)", overflow: "hidden" }}>
        {BASEMAPS.map(({ id, label, icon: Icon }) => {
          const active = mapType === id;
          return (
            <button key={id} onClick={() => setMapType(id)} title={label}
              style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 36, height: 36, border: "none", cursor: "pointer", background: active ? "#f0f9ff" : "transparent", borderBottom: id !== "hybrid" ? "1px solid #f1f5f9" : "none" }}
              onMouseEnter={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "#f8fafc"; }}
              onMouseLeave={e => { if (!active) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}>
              <Icon size={14} color={active ? "#0284c7" : "#9ca3af"} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ─── GeoJSON Boundary Layer ───────────────────────────────────────────────────

const NagpurBoundaryLayer = React.memo(() => {
  const map      = useMap();
  const layerRef = useRef<L.GeoJSON | null>(null);

  useEffect(() => {
    let cancelled = false;

    const addFallback = () => {
      if (cancelled || layerRef.current) return;
      const bbox = [78.65, 20.70, 79.70, 21.58];
      const coords: L.LatLngTuple[] = [
        [bbox[1], bbox[0]], [bbox[1], bbox[2]],
        [bbox[3], bbox[2]], [bbox[3], bbox[0]], [bbox[1], bbox[0]],
      ];
      const poly = L.polygon(coords, { color: "#38bdf8", weight: 2, fillOpacity: 0, dashArray: "6 4", opacity: 0.85 });
      poly.addTo(map);
      layerRef.current = poly as unknown as L.GeoJSON;
    };

    fetch("/nagpur_boundary.geojson")
      .then(r => { if (!r.ok) throw new Error("not found"); return r.json(); })
      .then(geojson => {
        if (cancelled) return;
        const layer = L.geoJSON(geojson, { style: { color: "#38bdf8", weight: 2.5, fillOpacity: 0, opacity: 0.9 } });
        layer.addTo(map);
        layerRef.current = layer;
      })
      .catch(() => addFallback());

    return () => {
      cancelled = true;
      if (layerRef.current) { map.removeLayer(layerRef.current); layerRef.current = null; }
    };
  }, [map]);

  return null;
});

// ─── Hover Tooltip — COG TIFF values only ────────────────────────────────────

const TOOLTIP_STYLE = `<style>.nagpur-tooltip .leaflet-popup-content-wrapper{border-radius:10px!important;box-shadow:0 4px 16px rgba(0,0,0,0.14)!important;padding:0!important;border:1px solid #e5e7eb;overflow:hidden}.nagpur-tooltip .leaflet-popup-content{margin:0!important;width:auto!important}.nagpur-tooltip .leaflet-popup-tip-container{display:none}</style>`;

const GLOBAL_CSS = `
.nagpur-tiles img {
  image-rendering: auto !important;
  filter: contrast(1.08) saturate(1.12) brightness(0.95);
  transform: scale(1.01);
}
.leaflet-image-layer.nagpur-heat-overlay {
  mix-blend-mode: normal;
  image-rendering: pixelated;
}
`;
if (typeof document !== "undefined") {
  const styleId = "nagpur-global-css";
  if (!document.getElementById(styleId)) {
    const el = document.createElement("style");
    el.id = styleId;
    el.textContent = GLOBAL_CSS;
    document.head.appendChild(el);
  }
}

function getTooltipValue(layer: LayerType, weekIndex: number, lat: number, lng: number): number | null {
  return sampleTiffValue(layer, weekIndex, lat, lng);
}

function isTiffLive(): boolean {
  return TIFF_CACHE !== null;
}

const HoverTooltip = React.memo(({ weekIndex, year, annualMeans, activeLayer }: {
  weekIndex: number; year: number; annualMeans: AnnualMeans; activeLayer: LayerType;
}) => {
  const popupRef     = useRef<L.Popup | null>(null);
  const isDragging   = useRef(false);
  const rafRef       = useRef<number | null>(null);
  const lastLatLng   = useRef<[number, number] | null>(null);
  const map          = useMap();

  useEffect(() => { prewarmTiffs(year); }, [year]);

  useEffect(() => {
    const onStart = () => {
      isDragging.current = true;
      try { if (popupRef.current) map.closePopup(popupRef.current); } catch (_) {}
    };
    const onEnd = () => { isDragging.current = false; };
    map.on("dragstart", onStart);
    map.on("dragend",   onEnd);
    return () => { map.off("dragstart", onStart); map.off("dragend", onEnd); };
  }, [map]);

  useMapEvents({
    mousemove(e) {
      if (isDragging.current) return;

      const { lat, lng } = e.latlng;
      // Use actual TIFF bbox so tooltip works across the full rendered canvas area.
      // Fallback to NAGPUR_BBOX if TIFF not yet loaded.
      const [bMinX, bMinY, bMaxX, bMaxY] = TIFF_CACHE
        ? TIFF_CACHE.bbox
        : [NAGPUR_BBOX.minLng, NAGPUR_BBOX.minLat, NAGPUR_BBOX.maxLng, NAGPUR_BBOX.maxLat];
      if (lng < bMinX || lng > bMaxX || lat < bMinY || lat > bMaxY) {
        try { if (popupRef.current) map.closePopup(popupRef.current); } catch (_) {}
        lastLatLng.current = null;
        return;
      }

      if (rafRef.current !== null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        buildTooltip(lat, lng);
      });
    },

    mouseout() {
      if (rafRef.current !== null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      try { if (popupRef.current) map.closePopup(popupRef.current); } catch (_) {}
      lastLatLng.current = null;
    },
  });

  function buildTooltip(lat: number, lng: number) {
    if (!popupRef.current) {
      popupRef.current = L.popup({
        closeButton: false, offset: [0, -4], maxWidth: 260,
        className: "nagpur-tooltip", autoPan: false,
      });
    }

    const d1      = dateFromWeek(year, weekIndex);
    const d2      = dateEndFromWeek(year, weekIndex);
    const weekStr = `${formatDateShort(d1)}–${formatDateShort(d2)}`;
    const am      = annualMeans;

    const srcBadge = (_layer: LayerType) =>
      isTiffLive()
        ? `<span style="font-size:7px;background:#dcfce7;color:#15803d;border-radius:3px;padding:1px 4px;font-weight:700;vertical-align:middle">COG</span>`
        : `<span style="font-size:7px;background:#fef9c3;color:#92400e;border-radius:3px;padding:1px 4px;font-weight:700;vertical-align:middle">Loading…</span>`;

    const delta = (val: number, annual: number): string => {
      const d   = val - annual;
      const col = d > 0 ? "#ef4444" : "#22c55e";
      const abs = Math.abs(d);
      const str = abs < 0.001 ? "0.0" : abs < 1 ? abs.toFixed(3) : abs.toFixed(1);
      return ` <span style="color:${col};font-size:9px">${d >= 0 ? "▲" : "▼"}${str}</span>`;
    };

    const header = `
<div style="padding:7px 10px;background:#1e293b;display:flex;align-items:center;justify-content:space-between;gap:8px">
  <div>
    <div style="font-size:11px;font-weight:700;color:#fff">📍 Nagpur</div>
    <div style="font-size:9px;color:rgba(255,255,255,0.45);margin-top:1px">${lat.toFixed(4)}°N, ${lng.toFixed(4)}°E</div>
  </div>
  <div style="background:rgba(249,115,22,0.18);border:1px solid rgba(249,115,22,0.3);border-radius:5px;padding:2px 7px;text-align:center;flex-shrink:0">
    <div style="font-size:8px;color:#fb923c;font-weight:700">WK</div>
    <div style="font-size:12px;font-weight:900;color:#f97316;font-family:monospace;line-height:1.1">${String(weekIndex+1).padStart(2,"0")}/52</div>
    <div style="font-size:7.5px;color:rgba(255,255,255,0.35)">${weekStr}</div>
  </div>
</div>`;

    const footer = `<div style="padding:3px 10px 5px;border-top:1px solid #f1f5f9"><span style="font-size:8px;color:#9ca3af">▲▼ vs ${year} annual avg · ${isTiffLive() ? "COG TIFF pixel" : "TIFF loading…"}</span></div>`;

    if (activeLayer === "lst") {
      const lst   = getTooltipValue("lst",   weekIndex, lat, lng);
      const ndvi  = getTooltipValue("ndvi",  weekIndex, lat, lng);
      const rain  = getTooltipValue("rain",  weekIndex, lat, lng);
      const soil  = getTooltipValue("soil",  weekIndex, lat, lng);
      const water = getTooltipValue("water", weekIndex, lat, lng);
      const lulcRaw   = getTooltipValue("lulc", weekIndex, lat, lng);
      const lulcIdx   = lulcRaw !== null ? Math.round(Math.max(0, Math.min(8, lulcRaw))) : null;
      const lulcLabel = lulcIdx !== null ? (LULC_CLASSES[lulcIdx]?.label ?? "—") : "No Data";

      const fmtOrND = (v: number | null, fmt: (n: number) => string) => v !== null ? fmt(v) : "No Data";

      const leftCol = [
        `<div style="margin-bottom:6px">
          <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">🌡 Temp ${srcBadge("lst")}</div>
          <div style="font-size:17px;font-weight:900;color:#ea580c;font-family:monospace;line-height:1.15">${fmtOrND(lst, v => `${v.toFixed(1)}°C${delta(v, am.lst)}`)}</div>
         </div>`,
        `<div style="margin-bottom:6px">
          <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">🌧 Rain ${srcBadge("rain")}</div>
          <div style="font-size:13px;font-weight:700;color:#0284c7;font-family:monospace">${fmtOrND(rain, v => `${v.toFixed(1)} mm${delta(v, am.rain)}`)}</div>
         </div>`,
        `<div>
          <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">🗺 LULC ${srcBadge("lulc")}</div>
          <div style="font-size:11px;font-weight:700;color:#7c3aed;font-family:monospace">${lulcLabel}</div>
         </div>`,
      ].join("");

      const rightCol = [
        `<div style="margin-bottom:6px">
          <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">🌿 NDVI ${srcBadge("ndvi")}</div>
          <div style="font-size:13px;font-weight:700;color:#16a34a;font-family:monospace">${fmtOrND(ndvi, v => `${v.toFixed(3)}${delta(v, am.ndvi)}`)}</div>
         </div>`,
        `<div style="margin-bottom:6px">
          <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">🌱 Soil ${srcBadge("soil")}</div>
          <div style="font-size:13px;font-weight:700;color:#65a30d;font-family:monospace">${fmtOrND(soil, v => `${(v*100).toFixed(1)}%${delta(v, am.soil)}`)}</div>
         </div>`,
        `<div>
          <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em">💧 Water ${srcBadge("water")}</div>
          <div style="font-size:13px;font-weight:700;color:#0891b2;font-family:monospace">${fmtOrND(water, v => `${v.toFixed(1)}%${delta(v, am.water)}`)}</div>
         </div>`,
      ].join("");

      popupRef.current.setLatLng([lat, lng]).setContent(`
${TOOLTIP_STYLE}
<div style="font-family:system-ui,-apple-system,sans-serif;width:240px;background:#fff">
  ${header}
  <div style="display:flex;padding:8px 10px 6px;gap:0;align-items:flex-start">
    <div style="flex:1;min-width:0;padding-right:8px">${leftCol}</div>
    <div style="width:1px;background:#f1f5f9;flex-shrink:0;align-self:stretch"></div>
    <div style="flex:1;min-width:0;padding-left:8px">${rightCol}</div>
  </div>
  ${footer}
</div>`).openOn(map);
      return;
    }

    const raw = getTooltipValue(activeLayer, weekIndex, lat, lng);

    let valDisplay    = "No Data";
    let annualDisplay = "—";
    let accentColor   = "#374151";

    if (raw !== null) {
      if (activeLayer === "ndvi") {
        accentColor   = "#16a34a";
        valDisplay    = `${raw.toFixed(3)}${delta(raw, am.ndvi)}`;
        annualDisplay = am.ndvi.toFixed(3);
      } else if (activeLayer === "rain") {
        accentColor   = "#0284c7";
        valDisplay    = `${raw.toFixed(1)} mm${delta(raw, am.rain)}`;
        annualDisplay = `${am.rain.toFixed(1)} mm`;
      } else if (activeLayer === "soil") {
        accentColor   = "#65a30d";
        valDisplay    = `${(raw*100).toFixed(1)}%${delta(raw, am.soil)}`;
        annualDisplay = `${(am.soil*100).toFixed(1)}%`;
      } else if (activeLayer === "water") {
        accentColor   = "#0891b2";
        valDisplay    = `${raw.toFixed(1)}%${delta(raw, am.water)}`;
        annualDisplay = `${am.water.toFixed(1)}%`;
      } else if (activeLayer === "lulc") {
        accentColor   = "#7c3aed";
        const cls     = Math.round(Math.max(0, Math.min(8, raw)));
        valDisplay    = LULC_CLASSES[cls]?.label ?? "—";
        annualDisplay = "—";
      }
    } else {
      if (activeLayer === "ndvi")  accentColor = "#16a34a";
      else if (activeLayer === "rain")  accentColor = "#0284c7";
      else if (activeLayer === "soil")  accentColor = "#65a30d";
      else if (activeLayer === "water") accentColor = "#0891b2";
      else if (activeLayer === "lulc")  accentColor = "#7c3aed";
    }

    const meta = LAYER_META[activeLayer];
    popupRef.current.setLatLng([lat, lng]).setContent(`
${TOOLTIP_STYLE}
<div style="font-family:system-ui,-apple-system,sans-serif;width:190px;background:#fff">
  ${header}
  <div style="padding:9px 12px 7px">
    <div style="font-size:9px;color:#9ca3af;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:4px">${meta.emoji} ${meta.name} ${srcBadge(activeLayer)}</div>
    <div style="font-size:20px;font-weight:900;color:${accentColor};font-family:monospace;line-height:1.2">${valDisplay}</div>
    ${activeLayer !== "lulc" ? `<div style="margin-top:5px;font-size:9px;color:#9ca3af">avg ${year}: <span style="color:#374151;font-weight:600">${annualDisplay}</span></div>` : ""}
  </div>
  ${footer}
</div>`).openOn(map);
  }

  return null;
});

// ─── Layer Switcher helpers ───────────────────────────────────────────────────

const LAYER_ORDER: LayerType[] = ["lst","ndvi","rain","soil","water","lulc"];

const LAYER_ACTIVE_COLORS: Record<LayerType, { bg: string; border: string; text: string }> = {
  lst:   { bg: "#fff7ed", border: "#fed7aa", text: "#ea580c" },
  ndvi:  { bg: "#f0fdf4", border: "#bbf7d0", text: "#16a34a" },
  rain:  { bg: "#f0f9ff", border: "#bae6fd", text: "#0284c7" },
  soil:  { bg: "#f7fee7", border: "#d9f99d", text: "#65a30d" },
  water: { bg: "#ecfeff", border: "#a5f3fc", text: "#0891b2" },
  lulc:  { bg: "#f5f3ff", border: "#ddd6fe", text: "#7c3aed" },
};

// ─── Week Navigator ──────────────────────────────────────────────────────────

function WeekNavigator({ weekIndex, year, setWeekIndex, setYear }: {
  weekIndex: number; year: number;
  setWeekIndex: (w: number) => void; setYear: (y: number) => void;
}) {
  const [open,        setOpen]        = React.useState(false);
  const dropRef                       = React.useRef<HTMLDivElement>(null);
  const [pickerYear,  setPickerYear]  = React.useState(year);
  const [pickerMonth, setPickerMonth] = React.useState(0);
  const [pickerWeek,  setPickerWeek]  = React.useState(weekIndex);

  React.useEffect(() => {
    setPickerYear(year);
    setPickerWeek(weekIndex);
    setPickerMonth(dateFromWeek(year, weekIndex).getMonth());
  }, [weekIndex, year]);

  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const d1 = dateFromWeek(year, weekIndex);
  const d2 = dateEndFromWeek(year, weekIndex);

  const weeksInMonth = useMemo(() => {
    const result: { wi: number; label: string }[] = [];
    for (let wi = 0; wi < N_WEEKS; wi++) {
      const d = dateFromWeek(pickerYear, wi);
      if (d.getMonth() === pickerMonth) {
        result.push({ wi, label: `Wk ${wi + 1} (${formatDateShort(d)}–${formatDateShort(dateEndFromWeek(pickerYear, wi))})` });
      }
    }
    return result;
  }, [pickerYear, pickerMonth]);

  const applyWeek = (wi: number, y: number) => {
    setYear(y);
    setWeekIndex(Math.max(0, Math.min(N_WEEKS - 1, wi)));
    setOpen(false);
  };

  return (
    <div ref={dropRef} style={{ position: "absolute", bottom: 20, left: "50%", transform: "translateX(-50%)", zIndex: 700 }}>
      <style>{`.ndate::-webkit-scrollbar{width:4px}.ndate::-webkit-scrollbar-thumb{background:#f97316;border-radius:4px}`}</style>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <button
          onClick={() => { if (weekIndex > 0) setWeekIndex(weekIndex - 1); else if (year > AVAILABLE_YEARS[0]) { setYear(year - 1); setWeekIndex(N_WEEKS - 1); } }}
          style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,width:36,height:36,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 8px rgba(0,0,0,0.08)",flexShrink:0 }}
          onMouseEnter={e=>(e.currentTarget.style.background="#f8fafc")} onMouseLeave={e=>(e.currentTarget.style.background="#fff")}>
          <svg width={14} height={14} viewBox="0 0 14 14" fill="none"><path d="M9 2L4 7l5 5" stroke="#374151" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>

        <button onClick={() => setOpen(o => !o)}
          style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:18,boxShadow:"0 4px 20px rgba(0,0,0,0.12)",padding:"10px 20px",display:"flex",alignItems:"center",gap:14,cursor:"pointer",userSelect:"none",minWidth:300 }}>
          <div style={{ display:"flex",flexDirection:"column",alignItems:"center",minWidth:46,flexShrink:0 }}>
            <span style={{ fontSize:22,fontWeight:900,color:"#111827",fontFamily:"monospace",lineHeight:1,letterSpacing:"-1px" }}>{year}</span>
            <span style={{ fontSize:9,color:"#f97316",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.12em",marginTop:2 }}>YEAR</span>
          </div>
          <div style={{ width:1,height:38,background:"#e5e7eb",flexShrink:0 }} />
          <div style={{ flex:1,textAlign:"left" }}>
            <span style={{ fontSize:11,color:"#9ca3af",display:"block",marginBottom:2,textTransform:"uppercase",letterSpacing:"0.08em" }}>Week {weekIndex + 1} / 52</span>
            <span style={{ fontSize:15,fontWeight:700,color:"#111827" }}>
              {formatDateShort(d1)}
              <span style={{ fontSize:12,color:"#9ca3af",marginLeft:4,fontWeight:400 }}>– {formatDateShort(d2)}</span>
            </span>
          </div>
          <svg width={16} height={16} viewBox="0 0 16 16" fill="none" style={{ flexShrink:0,transition:"transform 0.2s",transform:open?"rotate(180deg)":"rotate(0deg)" }}>
            <path d="M4 6l4 4 4-4" stroke="#f97316" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>

        <button
          onClick={() => { if (weekIndex < N_WEEKS - 1) setWeekIndex(weekIndex + 1); else if (year < AVAILABLE_YEARS[AVAILABLE_YEARS.length - 1]) { setYear(year + 1); setWeekIndex(0); } }}
          style={{ background:"#fff",border:"1px solid #e5e7eb",borderRadius:12,width:36,height:36,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",boxShadow:"0 2px 8px rgba(0,0,0,0.08)",flexShrink:0 }}
          onMouseEnter={e=>(e.currentTarget.style.background="#f8fafc")} onMouseLeave={e=>(e.currentTarget.style.background="#fff")}>
          <svg width={14} height={14} viewBox="0 0 14 14" fill="none"><path d="M5 2l5 5-5 5" stroke="#374151" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
      </div>

      {open && (
        <div className="ndate" style={{ position:"absolute",bottom:"calc(100% + 10px)",left:"50%",transform:"translateX(-50%)",background:"#fff",border:"1px solid #e5e7eb",borderRadius:16,boxShadow:"0 -8px 40px rgba(0,0,0,0.15)",padding:"16px",minWidth:320,zIndex:900,maxHeight:420,overflowY:"auto" }}>
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:10,color:"#9ca3af",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8 }}>Select Year</div>
            <div style={{ display:"flex",flexWrap:"wrap",gap:6 }}>
              {YEARS.map(y => (
                <button key={`year-${y}`} onClick={() => setPickerYear(y)}
                  style={{ padding:"5px 12px",borderRadius:8,border:`1.5px solid ${pickerYear===y?"#f97316":"#e5e7eb"}`,background:pickerYear===y?"#fff7ed":"#f8fafc",color:pickerYear===y?"#f97316":"#374151",fontSize:12,fontWeight:700,cursor:"pointer",position:"relative" }}>
                  {y}
                </button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:10,color:"#9ca3af",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8 }}>Select Month</div>
            <div style={{ display:"flex",flexWrap:"wrap",gap:5 }}>
              {MONTH_NAMES.map((mn,mi) => (
                <button key={mn} onClick={() => { setPickerMonth(mi); setPickerWeek(weeksInMonth.find(w => w.wi >= 0)?.wi ?? 0); }}
                  style={{ padding:"5px 10px",borderRadius:8,border:`1.5px solid ${pickerMonth===mi?"#f97316":"#e5e7eb"}`,background:pickerMonth===mi?"#fff7ed":"#f8fafc",color:pickerMonth===mi?"#f97316":"#374151",fontSize:11,fontWeight:700,cursor:"pointer" }}>{mn}</button>
              ))}
            </div>
          </div>
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:10,color:"#9ca3af",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:8 }}>Select Week</div>
            <div style={{ display:"flex",flexDirection:"column",gap:5 }}>
              {weeksInMonth.map(({ wi, label }) => (
                <button key={wi} onClick={() => setPickerWeek(wi)}
                  style={{ padding:"7px 12px",borderRadius:8,border:`1.5px solid ${pickerWeek===wi?"#f97316":"#e5e7eb"}`,background:pickerWeek===wi?"#fff7ed":"#f8fafc",color:pickerWeek===wi?"#f97316":"#374151",fontSize:11,fontWeight:600,cursor:"pointer",textAlign:"left" }}>{label}</button>
              ))}
            </div>
          </div>
          <button onClick={() => applyWeek(pickerWeek, pickerYear)}
            style={{ width:"100%",padding:"10px",background:"#f97316",color:"#fff",border:"none",borderRadius:10,fontSize:13,fontWeight:700,cursor:"pointer",marginTop:4 }}>
            Go to Week {pickerWeek + 1} · {pickerYear}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Timeline Controls (Play/Pause + Year Slider + Layer Dropdown) ────────────

function TimelineControlsInline({
  year,
  setYear,
  isPlaying,
  setIsPlaying,
  activeLayer,
  setActiveLayer,
  isDataLoaded,
}: {
  year: number;
  setYear: (y: number) => void;
  isPlaying: boolean;
  setIsPlaying: (v: boolean) => void;
  activeLayer: LayerType;
  setActiveLayer: (l: LayerType) => void;
  isDataLoaded: boolean;
}) {
  return (
    <div style={{
      width: "100%",
      background: "rgba(255,255,255,0.95)",
      backdropFilter: "blur(6px)",
      WebkitBackdropFilter: "blur(6px)",
      padding: "6px 10px",
      borderRadius: "10px",
      border: "1px solid rgba(0,0,0,0.10)",
      boxShadow: "0 2px 12px rgba(0,0,0,0.10)",
      display: "flex",
      alignItems: "center",
      gap: "7px",
    }}>

      {/* Play / Pause */}
      <button
        onClick={() => { if (isDataLoaded) setIsPlaying(!isPlaying); }}
        disabled={!isDataLoaded}
        title={!isDataLoaded ? "Loading data…" : isPlaying ? "Pause" : "Play"}
        style={{
          width: 28, height: 28, borderRadius: "50%",
          background: !isDataLoaded ? "#e5e7eb" : isPlaying ? "#0ea5e9" : "#e0f2fe",
          color: !isDataLoaded ? "#9ca3af" : isPlaying ? "#fff" : "#0ea5e9",
          fontSize: 11, cursor: isDataLoaded ? "pointer" : "not-allowed",
          display: "flex", alignItems: "center", justifyContent: "center",
          flexShrink: 0, transition: "all 0.18s",
          border: `1.5px solid ${!isDataLoaded ? "#e5e7eb" : "#0ea5e9"}`,
        }}
      >
        {!isDataLoaded ? "⏳" : isPlaying ? "⏸" : "▶"}
      </button>

      {/* Slider */}
      <input
        type="range"
        min={AVAILABLE_YEARS[0]}
        max={AVAILABLE_YEARS[AVAILABLE_YEARS.length - 1]}
        step={1}
        value={year}
        onChange={e => setYear(Number(e.target.value))}
        style={{ flex: 1, accentColor: "#0ea5e9", cursor: "pointer" }}
      />

      {/* Year badge */}
      <span style={{
        flexShrink: 0, fontSize: 12, fontWeight: 700,
        color: "#0ea5e9", fontFamily: "monospace",
        minWidth: 36, textAlign: "center",
      }}>
        {year}
      </span>

      {/* Layer Dropdown */}
      <select
        value={activeLayer}
        onChange={e => setActiveLayer(e.target.value as LayerType)}
        style={{
          flexShrink: 0, fontSize: 11, fontWeight: 600,
          background: "#f8fafc", border: "1px solid #e5e7eb",
          borderRadius: 6, color: "#374151",
          padding: "3px 5px", cursor: "pointer",
        }}
      >
        {LAYER_ORDER.map(layer => (
          <option key={layer} value={layer}>
            {LAYER_META[layer].emoji} {LAYER_META[layer].label}
          </option>
        ))}
      </select>

    </div>
  );
}

// ─── Year Timeline ────────────────────────────────────────────────────────────

function YearTimeline({ year, setYear, weekIndex, setWeekIndex }: {
  year: number; setYear: (y: number) => void; weekIndex: number; setWeekIndex: (w: number) => void;
}) {
  return (
    <div style={{ position:"absolute",top:16,left:"50%",transform:"translateX(-50%)",zIndex:600,pointerEvents:"auto" }}>
      <div style={{ background:"rgba(255,255,255,0.97)",border:"1px solid #e5e7eb",borderRadius:999,padding:"6px 10px",boxShadow:"0 2px 12px rgba(0,0,0,0.08)",display:"flex",alignItems:"center",gap:4 }}>
        {YEARS.map(y => (
          <button key={`year-${y}`}
            onClick={() => { setYear(y); setWeekIndex(Math.min(weekIndex, N_WEEKS - 1)); }}
            style={{ padding:"4px 10px",borderRadius:999,border:"none",background:y===year?"#f97316":"transparent",color:y===year?"#fff":"#6b7280",fontSize:11,fontWeight:700,cursor:"pointer",transition:"all 0.15s",position:"relative" }}
            onMouseEnter={e => { if (y!==year) (e.currentTarget as HTMLButtonElement).style.background="#f8fafc"; }}
            onMouseLeave={e => { if (y!==year) (e.currentTarget as HTMLButtonElement).style.background="transparent"; }}>
            {y}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Layer Legend ─────────────────────────────────────────────────────────────

function LayerLegend({ activeLayer }: { activeLayer: LayerType }) {
  const meta   = LAYER_META[activeLayer];
  const legend = LAYER_LEGEND[activeLayer];
  if (activeLayer === "lulc") {
    return (
      <div style={{ position:"absolute",bottom:110,left:16,zIndex:500 }}>
        <Card style={{ padding:"10px 14px",minWidth:180 }}>
          <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:6 }}>
            <Activity size={13} color="#0ea5e9" />
            <span style={{ fontSize:11,color:"#9ca3af",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.07em" }}>LULC Classes</span>
          </div>
          <p style={{ fontSize:13,fontWeight:700,color:"#111827",marginBottom:8 }}>{meta.emoji} {meta.name}</p>
          <div style={{ display:"flex",flexDirection:"column",gap:3 }}>
            {LULC_CLASSES.map(c => (
              <div key={c.label} style={{ display:"flex",alignItems:"center",gap:6 }}>
                <span style={{ width:10,height:10,borderRadius:2,background:c.color,flexShrink:0,display:"inline-block" }} />
                <span style={{ fontSize:10,color:"#374151" }}>{c.label}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }
  return (
    <div style={{ position:"absolute",bottom:110,left:16,zIndex:500 }}>
      <Card style={{ padding:"10px 14px",minWidth:190 }}>
        <div style={{ display:"flex",alignItems:"center",gap:6,marginBottom:6 }}>
          <Activity size={13} color="#0ea5e9" />
          <span style={{ fontSize:11,color:"#9ca3af",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.07em" }}>Colour Legend</span>
        </div>
        <p style={{ fontSize:13,fontWeight:700,color:"#111827",marginBottom:8 }}>{meta.emoji} {meta.name}</p>
        <div style={{ height:12,borderRadius:99,background:legend.gradient,boxShadow:"inset 0 1px 3px rgba(0,0,0,0.12)",marginBottom:6 }} />
        <div style={{ display:"flex",justifyContent:"space-between" }}>
          <span style={{ fontSize:11,color:"#6b7280",fontWeight:600 }}>{legend.lowLabel}</span>
          <span style={{ fontSize:11,color:"#6b7280",fontWeight:600 }}>{legend.highLabel}</span>
        </div>
      </Card>
    </div>
  );
}

// ─── Map Instance ─────────────────────────────────────────────────────────────

function MapInstance({ setMap }: { setMap: (map: L.Map) => void }) {
  const map = useMap();
  useEffect(() => { setMap(map); }, [map, setMap]);
  return null;
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function Nagpur() {
  const [year,        setYearRaw]    = useState<number>(DEFAULT_YEAR);
  const [weekIndex,   setWeekRaw]    = useState<number>(0);
  const [mapType,     setMapType]    = useState<MapType>("osm");
  const [activeLayer, setActiveLayer]= useState<LayerType>("lst");
  const [infoOpen,    setInfoOpen]   = useState(false);
  const [layerOpen,   setLayerOpen]  = useState(false);

  const [isPlaying,     setIsPlaying]     = useState<boolean>(false);
  const [isDataLoaded,  setIsDataLoaded]  = useState<boolean>(false);
  const [tiffReady, setTiffReady]         = useState<boolean>(false);
  const [realStats,  setRealStats]      = useState<RealStats>(() => getWeekStats(activeLayer, weekIndex));
  const [annualMeans, setAnnualMeans]   = useState<AnnualMeans>(() => computeAnnualMeans());

  const setYear = useCallback((y: number) => {
    setYearRaw(y);
    const existing = TIFF_CACHE_MAP.get(y);
    if (existing) {
      TIFF_CACHE   = existing;
      _ACTIVE_YEAR = y;
      clearHeatmapCache();
      setTiffReady(true);
      setIsDataLoaded(true);
    } else {
      TIFF_CACHE = null;
      setTiffReady(false);
      setIsDataLoaded(false);
      loadMainTiff(y).then(cache => {
        if (cache) {
          clearHeatmapCache();
          detectAndLogScales(cache.bands, cache.nodata);
          setTiffReady(true);
          setIsDataLoaded(true);
        }
      });
    }
  }, []);

  // ── Play/Pause auto-advance (only when data is loaded) ──────────────────────
  const yearRef = useRef(year);
  yearRef.current = year;
  useEffect(() => {
    if (!isPlaying || !isDataLoaded) return;
    const interval = setInterval(() => {
      if (yearRef.current >= AVAILABLE_YEARS[AVAILABLE_YEARS.length - 1]) {
        // End of cycle — stop and wait for manual play press
        setIsPlaying(false);
      } else {
        setYear(yearRef.current + 1);
      }
    }, 1500);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, isDataLoaded]);

  // ── Background preload: after current year loads, silently load other years ──
  useEffect(() => {
    if (!isDataLoaded) return;
    // Preload adjacent years in background — descending from current, then ascending
    const allOthers = AVAILABLE_YEARS.filter(y => y !== year);
    const ordered = [
      ...allOthers.filter(y => y < year).sort((a, b) => b - a),
      ...allOthers.filter(y => y > year).sort((a, b) => a - b),
    ];
    let cancelled = false;
    const preload = async () => {
      for (const y of ordered) {
        if (cancelled) break;
        if (!TIFF_CACHE_MAP.has(y)) {
          await loadMainTiff(y);
          // Small pause between fetches to not saturate bandwidth
          await new Promise(r => setTimeout(r, 500));
        }
      }
    };
    preload();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDataLoaded, year]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      if (cancelled) return;
      if (TIFF_CACHE_MAP.has(year) || TIFF_CACHE) {
        const c = TIFF_CACHE_MAP.get(year);
        if (c) { TIFF_CACHE = c; _ACTIVE_YEAR = year; }
        setTiffReady(true);
        setIsDataLoaded(true);
        setRealStats(getWeekStats(activeLayer, weekIndex));
        setAnnualMeans(computeAnnualMeans());
      } else {
        setTimeout(poll, 300);
      }
    };
    poll();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setRealStats(getWeekStats(activeLayer, weekIndex));
  }, [activeLayer, weekIndex, tiffReady]);

  useEffect(() => {
    setAnnualMeans(computeAnnualMeans());
  }, [year, tiffReady]);

  const tileYear       = year;

  const setWeekIndex = useCallback((w: number) => { setWeekRaw(w); }, []);

  const meta = LAYER_META[activeLayer];
  const info = LAYER_INFO[activeLayer];
  const d1   = dateFromWeek(year, weekIndex);
  const d2   = dateEndFromWeek(year, weekIndex);

  const setMap = useCallback((_map: L.Map) => {}, []);

  return (
    <div style={{ display:"flex", height:"100vh", width:"100%", fontFamily:"'Inter',system-ui,sans-serif", overflow:"hidden", background:"#f1f5f9" }}>
      {infoOpen && <InfoTab activeLayer={activeLayer} onClose={() => setInfoOpen(false)} />}

      <div style={{ flex:1, position:"relative", cursor:"crosshair" }}>
        <MapContainer
          bounds={[[20.70, 78.65], [21.58, 79.70]]}
          zoom={10}
          style={{ width:"100%", height:"100vh" }}
          zoomControl={false}
          maxZoom={18}
          minZoom={7}
        >
          <MapInstance setMap={setMap} />
          <BasemapTiles mapType={mapType} />
          <RasterTileLayer year={tileYear} />
          {tiffReady && <CanvasHeatmapLayer activeLayer={activeLayer} weekIndex={weekIndex} year={year} />}
          <NagpurBoundaryLayer />
          <HoverTooltip
            weekIndex={weekIndex}
            year={year}
            annualMeans={annualMeans}
            activeLayer={activeLayer}
          />
          <MapControls mapType={mapType} setMapType={setMapType} />
        </MapContainer>

        <div style={{ position:"absolute", top:60, left:"50%", transform:"translateX(-50%)", zIndex:600, pointerEvents:"none" }}>
          <div style={{ background:"rgba(255,255,255,0.95)", border:"1px solid #e5e7eb", borderRadius:999, padding:"5px 14px", boxShadow:"0 2px 12px rgba(0,0,0,0.08)", display:"flex", alignItems:"center", gap:6 }}>
            <span style={{ width:7, height:7, borderRadius:"50%", background:meta.dotColor, display:"inline-block" }} />
            <span style={{ fontSize:11.5, fontWeight:600, color:"#374151" }}>{meta.emoji} {meta.name}</span>
            <span style={{ fontSize:10, color:"#9ca3af" }}>· {meta.desc}</span>
            <span style={{ fontSize:10, color:"#9ca3af" }}>· Week {weekIndex + 1} · {formatDateShort(d1)}–{formatDateShort(d2)}</span>
            {activeLayer === "lst" && realStats.tiffDerived && (
              <span style={{ fontSize:10, color:"#f97316", fontWeight:600 }}>· {realStats.avg.toFixed(1)}°C avg</span>
            )}
          </div>
        </div>

        {/* Left panel: layer dropdown + timeline controls stacked together */}
        <div style={{ position:"absolute", top:16, left:infoOpen?356:16, zIndex:700, transition:"left 0.22s cubic-bezier(0.22,1,0.36,1)", display:"flex", flexDirection:"column", gap:6, width:300 }}>

          {/* Layer dropdown card */}
          <div style={{ background:"rgba(255,255,255,0.97)", border:"1px solid #e5e7eb", borderRadius:14, boxShadow:"0 4px 20px rgba(0,0,0,0.10)", padding:"6px 8px", display:"flex", flexDirection:"column", gap:0, width:"100%", overflow:"hidden", boxSizing:"border-box" }}>
            <button onClick={() => setLayerOpen(o => !o)}
              style={{ display:"flex", alignItems:"center", justifyContent:"space-between", gap:6, padding:"5px 4px 6px", background:"transparent", border:"none", cursor:"pointer", width:"100%", borderRadius:8, boxSizing:"border-box" }}
              onMouseEnter={e=>(e.currentTarget.style.background="#f8fafc")} onMouseLeave={e=>(e.currentTarget.style.background="transparent")}>
              <div style={{ display:"flex", alignItems:"center", gap:6, overflow:"hidden" }}>
                <span style={{ fontSize:15, lineHeight:1, flexShrink:0 }}>{LAYER_META[activeLayer].emoji}</span>
                <span style={{ fontSize:11, fontWeight:700, color:LAYER_ACTIVE_COLORS[activeLayer].text, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{LAYER_META[activeLayer].label}</span>
              </div>
              <svg width={12} height={12} viewBox="0 0 12 12" fill="none" style={{ transition:"transform 0.2s", transform:layerOpen?"rotate(180deg)":"rotate(0deg)", flexShrink:0 }}>
                <path d="M2 4l4 4 4-4" stroke="#9ca3af" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {layerOpen && (
              <div style={{ display:"flex", flexDirection:"column", gap:2, marginTop:2, borderTop:"1px solid #f1f5f9", paddingTop:6, width:"100%", boxSizing:"border-box" }}>
                {LAYER_ORDER.filter(l => l !== activeLayer).map(layer => {
                  const lm = LAYER_META[layer]; const ac = LAYER_ACTIVE_COLORS[layer];
                  return (
                    <button key={layer} onClick={() => { setActiveLayer(layer); setLayerOpen(false); }} title={lm.name}
                      style={{ display:"flex", alignItems:"center", gap:6, padding:"6px 8px", borderRadius:9, border:"1px solid transparent", background:"transparent", cursor:"pointer", transition:"all 0.15s", width:"100%", boxSizing:"border-box", overflow:"hidden" }}
                      onMouseEnter={e=>{(e.currentTarget as HTMLButtonElement).style.background=ac.bg; (e.currentTarget as HTMLButtonElement).style.border=`1px solid ${ac.border}`;}}
                      onMouseLeave={e=>{(e.currentTarget as HTMLButtonElement).style.background="transparent"; (e.currentTarget as HTMLButtonElement).style.border="1px solid transparent";}}>
                      <span style={{ fontSize:15, lineHeight:1, flexShrink:0 }}>{lm.emoji}</span>
                      <span style={{ fontSize:10.5, fontWeight:500, color:"#6b7280", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{lm.label}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          {/* Timeline controls — always below dropdown, never overlaps */}
          <TimelineControlsInline
            year={year}
            setYear={setYear}
            isPlaying={isPlaying}
            setIsPlaying={setIsPlaying}
            activeLayer={activeLayer}
            setActiveLayer={setActiveLayer}
            isDataLoaded={isDataLoaded}
          />

        </div>

        <div style={{ position:"absolute", bottom:320, left:infoOpen?356:16, zIndex:700, transition:"left 0.22s cubic-bezier(0.22,1,0.36,1)" }}>
          <button onClick={() => setInfoOpen(o => !o)} title="Layer Information"
            style={{ width:38, height:38, background:infoOpen?info.accentColor:"#fff", border:`1.5px solid ${infoOpen?info.accentColor:"#e5e7eb"}`, borderRadius:10, boxShadow:"0 4px 16px rgba(0,0,0,0.10)", cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", transition:"all 0.18s" }}>
            <Info size={16} color={infoOpen?"#fff":info.accentColor} />
          </button>
        </div>

        <YearTimeline year={year} setYear={setYear} weekIndex={weekIndex} setWeekIndex={setWeekIndex} />
        <LayerLegend activeLayer={activeLayer} />
        <WeekNavigator weekIndex={weekIndex} year={year} setWeekIndex={setWeekIndex} setYear={setYear} />
      </div>

      <aside style={{ width:272, flexShrink:0, display:"flex", flexDirection:"column", background:"#f8fafc", borderLeft:"1px solid #e5e7eb", overflowY:"auto", zIndex:10 }}>
        <div style={{ padding:"18px 16px 12px", borderBottom:"1px solid #e5e7eb", background:"#fff" }}>
          <p style={{ fontSize:13, fontWeight:700, color:"#111827" }}>Analytics</p>
          <p style={{ fontSize:11, color:"#9ca3af", marginTop:2 }}>
            Nagpur District · {year}
            <span style={{ color:"#22c55e", fontWeight:700 }}> · Tiles ✓</span>
          </p>
        </div>
        <div style={{ padding:"12px 12px 20px" }}>
          <AnalyticsContent
            stats={realStats}
            activeLayer={activeLayer}
            weekIndex={weekIndex}
            year={year}
            annualMeans={annualMeans}
          />
        </div>
      </aside>
    </div>
  );
}
