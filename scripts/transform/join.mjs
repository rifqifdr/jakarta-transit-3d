/**
 * Joining operator timetables to OpenStreetMap geometry.
 *
 * This is the hinge the whole multi-modal build turns on. Not one operator
 * source — not KCI, not MRT, not either LRT — returns a coordinate, and OSM
 * has no timetable. Neither half is usable alone, and the only thing they
 * share is the station name.
 *
 * Measured on the KRL network: 82 of the 83 Jabodetabek stations match on a
 * normalised name once four aliases are supplied. The single miss sat outside
 * the query bbox rather than failing to match, so the bbox was widened and the
 * alias table stayed at four rows. That ratio is the reason this is a name
 * join and not something cleverer.
 *
 * Aliases live in data/aliases.json, checked in, because they are editorial
 * decisions about two names meaning one place — not data, and not derivable.
 */
import {readFileSync} from 'node:fs';
import {dirname, join as pathJoin} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = pathJoin(dirname(fileURLToPath(import.meta.url)), '..', '..'),
    ALIAS_FILE = pathJoin(ROOT, 'data', 'aliases.json'),

    // Below this length a prefix match says almost nothing — "DURI" would
    // happily swallow half the network.
    MIN_CONTAINMENT_LENGTH = 6;

/**
 * Names arrive in every register: KCI shouts ("MANGGARAI"), MRT prefixes
 * ("Stasiun MRT Blok M BCA"), OSM keeps the sponsor ("Blok M BCA"). Strip the
 * decoration, fold the case, drop the punctuation — but keep the sponsor,
 * because it is often the only thing distinguishing two nearby stations and
 * both sides carry it.
 */
export function normaliseName(name) {
    return String(name || '')
        // MRT ships at least one station name with a leading space, which
        // silently defeats every anchored strip below.
        .trim()
        .toUpperCase()
        .replace(/^STASIUN\s+MRT\s+/, '')
        .replace(/^STASIUN\s+/, '')
        .replace(/^ST\.?\s+/, '')
        .replace(/\bUNIV\.?\b/g, 'UNIVERSITAS')
        .replace(/[^A-Z0-9]/g, '');
}

export function loadAliases() {
    try {
        return JSON.parse(readFileSync(ALIAS_FILE, 'utf8'));
    } catch {
        return {};
    }
}

/**
 * Builds a lookup from an OSM node list.
 *
 * OSM returns several nodes for one station — a stop position and one or more
 * platforms — which is the same containers problem GTFS solves with
 * parent_station. The first node for a name wins and the rest are counted, so
 * a station is one place rather than four.
 */
export function indexOsmStations(elements) {
    const byName = new Map(),
        byRef = new Map();
    let duplicates = 0;

    for (const node of elements) {
        const name = node.tags?.name;

        if (!name || node.lat === undefined) {
            continue;
        }

        const key = normaliseName(name);

        if (byName.has(key)) {
            duplicates++;
        } else {
            byName.set(key, {
                name,
                lat: node.lat,
                lon: node.lon,
                osmId: node.id,
                operator: node.tags.operator || null
            });
        }

        // Some nodes carry the operator's own station code. Rare — five nodes
        // in the whole Jabodetabek extract — but free when present.
        const ref = node.tags?.ref;

        if (ref && !byRef.has(ref.toUpperCase().trim())) {
            byRef.set(ref.toUpperCase().trim(), byName.get(key));
        }
    }
    return {byName, byRef, duplicates};
}

/**
 * Resolves operator stations against the OSM index.
 *
 * @param stations [{id, name}] from an operator source
 * @param index    from indexOsmStations
 * @returns {matched: Map<id, {lat, lon, …}>, unmatched: [{id, name}], via}
 */
export function joinStations(stations, index, {aliases = loadAliases()} = {}) {
    const matched = new Map(),
        unmatched = [],
        ambiguous = [],
        via = {name: 0, alias: 0, ref: 0, containment: 0};

    for (const station of stations) {
        const key = normaliseName(station.name),
            aliasTarget = aliases[station.id] || aliases[station.name];

        let hit = index.byName.get(key);

        if (hit) {
            via.name++;
        } else if (aliasTarget) {
            hit = index.byName.get(normaliseName(aliasTarget));
            if (hit) {
                via.alias++;
            }
        }

        if (!hit) {
            const byRef = index.byRef.get(String(station.id).toUpperCase());

            if (byRef) {
                hit = byRef;
                via.ref++;
            }
        }

        // Last resort: one side carries something the other does not — a
        // sponsor OSM knows about ("Blok A" against "Blok A VISA"), or a
        // plural ("ASEAN Headquarter" against "ASEAN Headquarters").
        //
        // Only accepted when exactly one candidate matches. Two candidates
        // means the name is ambiguous, and a confidently wrong station is far
        // worse than an unmatched one.
        if (!hit && key.length >= MIN_CONTAINMENT_LENGTH) {
            const near = [...index.byName.entries()]
                .filter(([candidate]) => candidate.startsWith(key) || key.startsWith(candidate));

            if (near.length === 1) {
                hit = near[0][1];
                via.containment++;
            } else if (near.length > 1) {
                ambiguous.push(`${station.id} ${station.name} -> ${near.map(([k]) => k).join(' | ')}`);
            }
        }

        if (hit) {
            matched.set(station.id, hit);
        } else {
            unmatched.push(station);
        }
    }

    return {matched, unmatched, ambiguous, via, rate: stations.length ? matched.size / stations.length : 0};
}

/**
 * Turns an OSM route relation into a flat coordinate array plus its ordered
 * stops.
 *
 * `out geom` inlines vertices into each way member, so the geometry is
 * assembled by walking the members in order. Members with a stop or platform
 * role are the station sequence and are not part of the line itself.
 *
 * A relation with geometry but no ordered stops is a line under construction —
 * MRT East-West is the live example — and is reported rather than guessed at.
 */
export function relationToShape(relation) {
    const members = relation.members || [],
        stops = [],
        ways = [];

    for (const member of members) {
        if (member.role === 'stop') {
            stops.push({osmId: member.ref, lat: member.lat, lon: member.lon});
            continue;
        }
        if (member.role === 'platform' || member.type !== 'way' || !member.geometry?.length) {
            continue;
        }
        ways.push(member.geometry);
    }

    const {coords, dropped} = stitch(ways);

    return {
        id: String(relation.id),
        name: relation.tags?.name || '',
        route: relation.tags?.route || null,
        operator: relation.tags?.operator || null,
        colour: relation.tags?.colour || relation.tags?.color || null,
        ref: relation.tags?.ref || null,
        coords,
        stops,
        // Ways that could not be attached to the growing path. Usually the
        // second track of a double-track line, which is the same route again.
        droppedWays: dropped,
        underConstruction: stops.length === 0
    };
}

/**
 * Assembles a relation's ways into one continuous path.
 *
 * Concatenating them in listed order is the obvious approach and it is wrong.
 * A rail route relation routinely carries *both* tracks, so the naive path runs
 * the line out and back: "Lin Bogor: Bogor → Jakarta Kota" came out 103 km long
 * against 50.6 km end to end, and trains projected onto it appeared to loop
 * between Bojonggede and Citayam because consecutive stops landed on opposite
 * passes.
 *
 * So each way is attached only if one of its ends meets the end of the path so
 * far — reversed if that is the end which matches. A way that meets neither is
 * a parallel track or a spur, and is dropped: it is the same route again, and
 * appending it is what created the loop.
 */
const JOIN_TOLERANCE_M = 60,
    M_PER_DEG_LAT = 110574,
    M_PER_DEG_LON = 111320 * Math.cos(-6.2 * Math.PI / 180);

function apart(a, b) {
    return Math.hypot((a.lon - b.lon) * M_PER_DEG_LON, (a.lat - b.lat) * M_PER_DEG_LAT);
}

function stitch(ways) {
    if (!ways.length) {
        return {coords: [], dropped: 0};
    }

    // Grow from both ends and keep retrying, because relation members are not
    // reliably listed in connected order. Anchoring on the first way and only
    // extending the tail throws away everything past the first gap — it dropped
    // 124 of Rangkasbitung's ways and reduced the MRT to 300 metres.
    const remaining = ways.slice(1),
        path = ways[0].slice();

    let progress = true;

    while (progress && remaining.length) {
        progress = false;

        for (let i = 0; i < remaining.length; i++) {
            const way = remaining[i],
                head = path[0],
                tail = path[path.length - 1],
                first = way[0],
                last = way[way.length - 1];

            let attached = null;

            if (apart(tail, first) <= JOIN_TOLERANCE_M) {
                attached = way.slice(1);
                path.push(...attached);
            } else if (apart(tail, last) <= JOIN_TOLERANCE_M) {
                attached = way.slice(0, -1).reverse();
                path.push(...attached);
            } else if (apart(head, last) <= JOIN_TOLERANCE_M) {
                attached = way.slice(0, -1);
                path.unshift(...attached);
            } else if (apart(head, first) <= JOIN_TOLERANCE_M) {
                attached = way.slice(1).reverse();
                path.unshift(...attached);
            }

            if (attached) {
                remaining.splice(i, 1);
                progress = true;
                break;
            }
        }
    }

    const coords = [];

    for (const point of path) {
        const n = coords.length;

        // Drop the duplicated joint so the line carries no zero-length segment.
        if (n >= 2 && coords[n - 2] === point.lon && coords[n - 1] === point.lat) {
            continue;
        }
        coords.push(point.lon, point.lat);
    }

    return {coords, dropped: remaining.length};
}
