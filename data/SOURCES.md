# Sarodyatra — data sources & credits

| Dataset | Source | Licence | How it was used |
|---|---|---|---|
| Pandal list, coordinates, descriptions, photos (191) | `dbaidya811/map_server` (coordinates from Google Maps place links), bundled in `dipbhattacharjee/Manchitra-App` | Apache-2.0 / MIT | Base pandal layer; photos are linked, not copied |
| Heritage (bonedi bari) & a few famous pujas (11) | `Manchitra-App` curated list — hand-checked whitelist only | MIT | Added where missing; coordinates flagged `approx` |
| 5 famous pujas missing from both lists | Placed on the OpenStreetMap road they are on | ODbL | Flagged `approx` |
| Roads, metro stations & tracks, bus stops | OpenStreetMap export of Kolkata (HOT raw-data-api, Sept 2025), via `rakesh765483/Spatial-Analysis-of-Kolkata-Metro-Bus-Interconnectivity` | ODbL | Road layer, routing graph, metro geometry, bus corridors |
| Metro timetable | Metro Railway Kolkata announcements (Blue/Green from 27 Jul 2026); Purple/Orange/Yellow approximate | — | `metro_timings.json` |
| Puja dates | West Bengal holiday list 2026 | — | `puja_calendar.json` (editable) |
| Local trains: 355 stations, 27 lines, 1,637 trains (Sealdah, Howrah, Circular); bus route numbers and stop order (603 routes) | [Calcutta Transport](https://github.com/arkodeepg/calcutta-transport) GTFS feed — Eastern / South Eastern Railway timetables via erail.in; stops and tracks © OpenStreetMap contributors | ODbL 1.0 | `rail_*.geojson`, `rail_timetable.json`, `bus_network.json` (`scripts/build_transit.py`); licence and credits in `data/raw/calcutta-transport/` |
| Food, toilets, water, hospitals, police, ATMs | OpenStreetMap via Overpass API (live, cached) | ODbL | Nearby panel |
| Weather | Open-Meteo | CC BY 4.0 | Sarathi weather tool |
| Base maps | CARTO, Esri World Imagery | per provider | Background tiles |

## Derived by Sarodyatra (methodology)
- **Zones** — locality names + position rules → North / Central / South / East / West; polygons = buffered convex hulls.
- **Popularity (1–5)** — curated famous list, featured flag, heritage age.
- **Nearest metro** — haversine distance; walking minutes = distance × 1.3 / 75 m per min.
- **Predicted closures** — non-arterial roads within ~125 m of every popularity-5 puja, no vehicles 16:00–04:00, Saptami–Navami.
- **Bus corridors** — named main/important roads carrying ≥ 2 OSM bus stops within ~35 m.
- **Crowd model** — popularity/5 × puja-day factor × hour curve; queue = base × index × 1.6.
- **Journey planner** — earliest-arrival Connection Scan over the real train timetable (4-min change); the station to get off is the one with the best arrival + onward time; pandals are chosen by value per minute (famous 100, bonedi 50, local 15 × popularity) with cheapest insertion until the time limit or the last train home.
- **Bus options** — a route is offered for a walking hop when it stops ≤ 450 m from both ends in the right direction; ride time = stop-to-stop distance × 1.3 at 14 km/h + 8 min wait (estimate, not a timetable).
- **Crowd raster** — Gaussian kernel (σ ≈ 380 m) weighted by popularity², 0.001° grid, 0–100.

Rebuild everything: `python scripts/build_all.py <folder with kolkata_line.shp>` (needs geopandas, pyogrio, rasterio, networkx).
