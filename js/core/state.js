
export const appState = {
    map: null,
    markerClusterGroup: null,
    charts: {
        magnitude: null,
        timeSeries: null,
        depth: null
    },
    userLocation: null,
    data: {
        currentEarthquakes: null,
        savedEarthquakes: new Map(),
        filters: {
            range: 'day',
            minimumMagnitude: 0
        }
    },
    measurement: {
        isActive: false,
        points: [],
        line: null,
        markers: []
    },
    heatmap: {
        layer: null,
        isActive: false
    },
    clusters: {
        analysisActive: false
    },
    risk: {
        isActive: false,
        layers: [],
        executionToken: null,
        timeouts: new Map()
    },
    memory: {
        cleanupIntervalId: null,
        tensorCleanupCounter: 0
    }
};

export function resetMeasurementState() {
    appState.measurement.isActive = false;
    appState.measurement.points = [];
    appState.measurement.line = null;
    appState.measurement.markers = [];
}

export function resetRiskState() {
    appState.risk.isActive = false;
    appState.risk.layers = [];
    appState.risk.executionToken = null;
    appState.risk.timeouts.clear();
}
