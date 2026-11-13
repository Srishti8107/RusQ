# Real Nepal data in the Kathmandu sample region

The sample scenario (people, SOS, reports) is fictional. The **background data** shown to the control
room is real and comes from public datasets on the ResQGrid source list. It is built once by
`scripts/build-nepal-data.mjs` into `apps/server/src/nepal/kathmandu-context.json` (≈116 KB, committed).
Raw downloads stay in `data/nepal/` (git-ignored).

| Layer | Source | Licence | What it is – and is not |
|---|---|---|---|
| Residents per ≈1 km area | WorldPop R2025A, population 2024, constrained, 100 m (`npl_pop_2024_CN_100m_R2025A_v1.tif`) | CC BY 4.0 | Modelled estimate of people **living** there. Not people affected or needing help. |
| Flood-prone land near rivers | Height above nearest drainage, from the Copernicus DEM GLO-30 + OpenStreetMap rivers | Copernicus DEM licence; ODbL | Terrain **susceptibility**: high = ≤ 3 m above the river and ≤ 600 m from it; moderate = ≤ 6 m. Not an observed flood. |
| Rivers | OpenStreetMap waterways (HOT export) | ODbL | Named rivers (Bagmati, Bishnumati, Tukucha, Balkhu, Manohara, Nakhu …). |
| Hospitals and clinics | OpenStreetMap health facilities (HOT export) | ODbL | 173 hospitals and 270 clinics in the box. OSM completeness varies. |
| September 2024 figures | NDRRMA Situation Report #4 (16 Oct 2024) | Government of Nepal | 250 deaths, 18 missing, 178 injured, > 17,000 rescued; 239.7 mm in 24 h at Kathmandu airport. Floods **and** landslides combined. |

## Where it is used

- **Dashboard**: map layers "Flood-prone land near rivers", "Rivers", "Hospitals"; columns "Residents (est.)" and
  "Flood-prone land" in *Areas by priority*; a *Reference* card with the official 2024 figures and all sources.
- **Decision support** (`shared/decision.ts`, `areaContext`): an area that already has SOS / reports and whose land is
  ≥ 5 % high flood-prone gets **+5** with the reason spelled out. Residents are shown but never counted as people
  needing help, and the data alone never creates an area.
- **SOS monitor**: nearest real hospital (OSM) and whether the person's area is low-lying riverside land.
- **Sample scenario** (`scripts/demo-flood.mjs`): the flood SOS / reports were moved onto riverside land the model
  marks high (Thapathali, Babarmahal).

## Checks

- Residents in the box: **1,177,257** (WorldPop 2024). Census 2021: Kathmandu Metropolitan City 845,767 + Lalitpur
  Metropolitan City 299,843 ≈ 1.15 M in a similar area. The older WorldPop 2020 (unconstrained and constrained)
  gave ≈ 3.4 M for the same box and was **not** used.
- Flood-prone model vs places reported flooded in Kathmandu in Sept 2024 (Balkhu, Kuleshwor, Teku, Thapathali,
  Sinamangal, Shankhamul, Kupondole; approximate coordinates, ±90 m): **6 of 7 high**. Five higher-ground places
  (Durbar Marg, Swayambhu, Baneshwor, Lazimpat, Patan Durbar Square): **0 marked**. Looser thresholds (5 m / 8 m)
  started marking dry places, so 3 m / 6 m was kept. A small check, not a validation study.
- The DEM is a surface model (it includes buildings), so dense built-up riverbanks can look higher than the ground.

## Looked at and not used

- **UNOSAT 2024 flood extents** (products 3983 / 3990 / 3993): the published Sentinel-1 layers end at 84.97° E –
  Kathmandu is not covered. The Kathmandu SPOT-6 assessment (3993) links to the same package on HDX; its vectors
  are not in it.
- **Zenodo 2019–2023 flood maps** (NDVI threshold): in the city they mark roofs and roads as "flooded" (checked on a
  rendered map), so they would mislead.

## Rebuild

```bash
mkdir -p data/nepal && cd data/nepal
curl -LO https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/2024/NPL/v1/100m/constrained/npl_pop_2024_CN_100m_R2025A_v1.tif
curl -L -o waterways.zip https://production-raw-data-api.s3.amazonaws.com/ISO3/NPL/waterways/hotosm_npl_waterways_osm_geojson.zip
curl -L -o health_osm.zip https://production-raw-data-api.s3.amazonaws.com/ISO3/NPL/health_facilities/hotosm_npl_health_facilities_osm_geojson.zip
mkdir -p waterways health && tar -xf waterways.zip -C waterways && tar -xf health_osm.zip -C health   # Windows: C:\Windows\System32\tar.exe
cd ../.. && node --max-old-space-size=4096 scripts/build-nepal-data.mjs
```

The DEM window is read straight from the Copernicus DEM open-data bucket on AWS.
