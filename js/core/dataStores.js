
import { calculateDistance } from '../utils/geo.js';

export const earthquakeCache = new Map();
export const processedEarthquakeIds = new Set();
export const markerMetadata = new WeakMap();

export const spatialIndex = {
    NE: [],
    NW: [],
    SE: [],
    SW: [],

    insert(earthquake) {
        const lat = earthquake.geometry.coordinates[1];
        const lon = earthquake.geometry.coordinates[0];

        if (lat >= 0 && lon >= 0) this.NE.push(earthquake);
        else if (lat >= 0 && lon < 0) this.NW.push(earthquake);
        else if (lat < 0 && lon >= 0) this.SE.push(earthquake);
        else this.SW.push(earthquake);
    },

    findNearby(lat, lon, radiusKm = 500) {
        const quadrant = lat >= 0 ? (lon >= 0 ? this.NE : this.NW) : (lon >= 0 ? this.SE : this.SW);
        return quadrant.filter(eq => {
            const distance = calculateDistance(
                lat, lon,
                eq.geometry.coordinates[1],
                eq.geometry.coordinates[0]
            );
            return distance <= radiusKm;
        });
    },

    clear() {
        this.NE = [];
        this.NW = [];
        this.SE = [];
        this.SW = [];
    }
};

export class PriorityQueue {
    constructor() {
        this.items = [];
    }

    enqueue(earthquake, priority) {
        const queueElement = { earthquake, priority };
        let added = false;

        for (let i = 0; i < this.items.length; i++) {
            if (queueElement.priority > this.items[i].priority) {
                this.items.splice(i, 0, queueElement);
                added = true;
                break;
            }
        }

        if (!added) {
            this.items.push(queueElement);
        }
    }

    dequeue() {
        return this.items.shift();
    }

    isEmpty() {
        return this.items.length === 0;
    }

    peek() {
        return this.items[0];
    }

    size() {
        return this.items.length;
    }

    clear() {
        this.items = [];
    }
}

export const alertQueue = new PriorityQueue();

export class LRUCache {
    constructor(maxSize = 50) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return null;

        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, value);
    }

    has(key) {
        return this.cache.has(key);
    }

    clear() {
        this.cache.clear();
    }

    size() {
        return this.cache.size;
    }
}

export const apiCache = new LRUCache(50);

export const realtimeStats = {
    total: 0,
    byMagnitude: {
        minor: 0,
        light: 0,
        moderate: 0,
        strong: 0,
        major: 0,
        great: 0
    },
    byDepth: {
        shallow: 0,
        intermediate: 0,
        deep: 0
    },
    byRegion: new Map(),
    maxMagnitude: 0,
    minMagnitude: 10,
    avgMagnitude: 0,
    lastUpdate: null,

    update(earthquake) {
        const mag = earthquake.properties.mag;
        const depth = Math.abs(earthquake.geometry.coordinates[2]);
        const place = earthquake.properties.place;

        this.total++;
        this.lastUpdate = new Date();

        if (mag < 3) this.byMagnitude.minor++;
        else if (mag < 4) this.byMagnitude.light++;
        else if (mag < 5) this.byMagnitude.moderate++;
        else if (mag < 6) this.byMagnitude.strong++;
        else if (mag < 7) this.byMagnitude.major++;
        else this.byMagnitude.great++;

        if (depth < 70) this.byDepth.shallow++;
        else if (depth < 300) this.byDepth.intermediate++;
        else this.byDepth.deep++;

        if (place && place.trim().length > 0) {
            let region = place.trim();

            if (region.includes(',')) {
                region = region.split(',').pop().trim();
            } else if (region.toLowerCase().includes(' of ')) {
                const parts = region.split(/\sof\s/i);
                region = parts[parts.length - 1].trim();
            }

            region = region.replace(/^(the\s+|near\s+|coast\s+of\s+)/i, '').trim();

            if (region.length > 0 && region.length < 100) {
                this.byRegion.set(region, (this.byRegion.get(region) || 0) + 1);
            }
        }

        if (mag > this.maxMagnitude) this.maxMagnitude = mag;
        if (mag < this.minMagnitude) this.minMagnitude = mag;
        this.avgMagnitude = ((this.avgMagnitude * (this.total - 1)) + mag) / this.total;
    },

    reset() {
        this.total = 0;
        this.byMagnitude = { minor: 0, light: 0, moderate: 0, strong: 0, major: 0, great: 0 };
        this.byDepth = { shallow: 0, intermediate: 0, deep: 0 };
        this.byRegion.clear();
        this.maxMagnitude = 0;
        this.minMagnitude = 10;
        this.avgMagnitude = 0;
        this.lastUpdate = null;
    },

    getTopRegions(limit = 5) {
        return Array.from(this.byRegion.entries())
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit);
    }
};
