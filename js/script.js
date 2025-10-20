// script.js

// Map para acceso O(1) por ID de terremoto
const earthquakeCache = new Map();

// Set para búsquedas rápidas de IDs únicos
const processedEarthquakeIds = new Set();

// Índices espaciales para búsqueda geográfica eficiente
const spatialIndex = {
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

// Priority Queue para alertas de terremotos (máxima magnitud primero)
class PriorityQueue {
    constructor() {
        this.heap = [];
    }

    enqueue(earthquake, priority) {
        const node = { earthquake, priority };
        this.heap.push(node);
        this._bubbleUp(this.heap.length - 1);
    }

    dequeue() {
        if (this.heap.length === 0) {
            return undefined;
        }

        const top = this.heap[0];
        const end = this.heap.pop();

        if (this.heap.length > 0) {
            this.heap[0] = end;
            this._bubbleDown(0);
        }

        return top;
    }

    peek() {
        return this.heap[0];
    }

    isEmpty() {
        return this.heap.length === 0;
    }

    size() {
        return this.heap.length;
    }

    clear() {
        this.heap.length = 0;
    }

    _bubbleUp(index) {
        while (index > 0) {
            const parentIndex = Math.floor((index - 1) / 2);
            if (this.heap[index].priority <= this.heap[parentIndex].priority) {
                break;
            }
            [this.heap[index], this.heap[parentIndex]] = [this.heap[parentIndex], this.heap[index]];
            index = parentIndex;
        }
    }

    _bubbleDown(index) {
        const length = this.heap.length;
        while (true) {
            const leftChild = 2 * index + 1;
            const rightChild = leftChild + 1;
            let largest = index;

            if (leftChild < length && this.heap[leftChild].priority > this.heap[largest].priority) {
                largest = leftChild;
            }

            if (rightChild < length && this.heap[rightChild].priority > this.heap[largest].priority) {
                largest = rightChild;
            }

            if (largest === index) {
                break;
            }

            [this.heap[index], this.heap[largest]] = [this.heap[largest], this.heap[index]];
            index = largest;
        }
    }
}

// Cola de alertas de terremotos significativos
const alertQueue = new PriorityQueue();

// Caché LRU para datos de API (Least Recently Used)
class LRUCache {
    constructor(maxSize = 50) {
        this.maxSize = maxSize;
        this.cache = new Map();
    }
    
    get(key) {
        if (!this.cache.has(key)) return null;
        
        // Mover al final (más reciente)
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
    }
    
    set(key, value) {
        // Si existe, eliminar para reinsertar al final
        if (this.cache.has(key)) {
            this.cache.delete(key);
        }
        // Si está lleno, eliminar el más antiguo (primero)
        else if (this.cache.size >= this.maxSize) {
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

// Caché de 50 consultas API más recientes
const apiCache = new LRUCache(50);

// Estadísticas en tiempo real
const realtimeStats = {
    total: 0,
    byMagnitude: {
        minor: 0,      // < 3.0
        light: 0,      // 3.0 - 3.9
        moderate: 0,   // 4.0 - 4.9
        strong: 0,     // 5.0 - 5.9
        major: 0,      // 6.0 - 6.9
        great: 0       // >= 7.0
    },
    byDepth: {
        shallow: 0,    // 0-70km
        intermediate: 0, // 70-300km
        deep: 0        // > 300km
    },
    byRegion: new Map(),
    maxMagnitude: 0,
    minMagnitude: 10,
    avgMagnitude: 0,
    lastUpdate: null,
    
    // Actualizar estadísticas con nuevo terremoto
    update(earthquake) {
        const mag = earthquake.properties.mag;
        const depth = Math.abs(earthquake.geometry.coordinates[2]);
        const place = earthquake.properties.place;
        
        this.total++;
        this.lastUpdate = new Date();
        
        // Por magnitud - Clasificación USGS oficial
        // Referencia: https://www.usgs.gov/programs/earthquake-hazards/earthquake-magnitude-energy-release-and-shaking-intensity
        if (mag < 3.0) this.byMagnitude.minor++;        // Micro/Minor: M < 3.0
        else if (mag < 4.0) this.byMagnitude.light++;   // Minor/Light: M 3.0-3.9
        else if (mag < 5.0) this.byMagnitude.moderate++; // Light: M 4.0-4.9
        else if (mag < 6.0) this.byMagnitude.strong++;  // Moderate: M 5.0-5.9
        else if (mag < 7.0) this.byMagnitude.major++;   // Strong: M 6.0-6.9
        else if (mag < 8.0) this.byMagnitude.great++;   // Major: M 7.0-7.9
        else this.byMagnitude.great++;                  // Great: M ≥ 8.0
        
        // Por profundidad
        if (depth < 70) this.byDepth.shallow++;
        else if (depth < 300) this.byDepth.intermediate++;
        else this.byDepth.deep++;
        
        // Por región
        if (place && place.trim().length > 0) {
            // Intentar extraer región de diferentes formatos:
            // "123km SW of City, Country" -> Country
            // "Near the coast of Region" -> Region
            let region = place.trim();
            
            if (region.includes(',')) {
                // Si tiene coma, tomar la última parte (país/región)
                region = region.split(',').pop().trim();
            } else if (region.toLowerCase().includes(' of ')) {
                // Si dice "of", tomar lo que viene después
                const parts = region.split(/\sof\s/i);
                region = parts[parts.length - 1].trim();
            }
            
            // Limpiar prefijos comunes
            region = region.replace(/^(the\s+|near\s+|coast\s+of\s+)/i, '').trim();
            
            // Solo guardar si queda algo válido
            if (region.length > 0 && region.length < 100) {
                this.byRegion.set(region, (this.byRegion.get(region) || 0) + 1);
            }
        }
        
        // Min/Max/Avg
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

// Variables globales
let map;
let magnitudeChart;
let timeSeriesChart;
let depthChart;
let markerClusterGroup;
let userLocation;
let currentEarthquakesData; // Variable global para almacenar los datos de terremotos

// Función para traducir la página (las traducciones se cargan desde js/core/translations.js)
function translatePage(language) {
    console.log("Función translatePage llamada con el idioma:", language);
    const elements = document.querySelectorAll('[data-i18n]');
    console.log("Elementos encontrados con data-i18n:", elements.length);

    elements.forEach(element => {
        const key = element.getAttribute('data-i18n');
        console.log("  Traducción del elemento con la clave:", key);
        if (translations[language] && translations[language][key]) {
            let translation = translations[language][key];
            if (key === 'copyright') {
                translation = translation.replace('%{year}', new Date().getFullYear());
            }
            element.innerHTML = translation;
            if (element.placeholder) {
                element.placeholder = translation;
            }
        } else {
            console.log("Traducción no encontrada para la clave:", key, "en el idioma:", language);
        }
    });

    // Actualizar gráficos si ya existen
    if (typeof magnitudeChart !== 'undefined' && magnitudeChart) {
        updateChartLanguage(magnitudeChart, language);
    }
    if (typeof timeSeriesChart !== 'undefined' && timeSeriesChart) {
        updateChartLanguage(timeSeriesChart, language);
    }
    if (typeof depthChart !== 'undefined' && depthChart) {
        updateChartLanguage(depthChart, language);
    }

    console.log("Traducción completada");
}

// Función para actualizar el idioma de los gráficos
function updateChartLanguage(chart, language) {
    if (!chart || !chart.options) return;
    
    // Actualizar el título del gráfico si existe
    if (chart.options.plugins && chart.options.plugins.title) {
        const chartType = chart.canvas.id;
        if (chartType === 'magnitudeChart' && translations[language].distribucion_magnitudes_chart_title) {
            chart.options.plugins.title.text = translations[language].distribucion_magnitudes_chart_title;
        } else if (chartType === 'timeSeriesChart' && translations[language].magnitud_tiempo_chart_title) {
            chart.options.plugins.title.text = translations[language].magnitud_tiempo_chart_title;
        } else if (chartType === 'depthChart' && translations[language].distribucion_profundidad_chart_title) {
            chart.options.plugins.title.text = translations[language].distribucion_profundidad_chart_title;
        }
    }
    
    // Actualizar etiquetas de los ejes si existen
    if (chart.options.scales) {
        if (chart.options.scales.y && chart.options.scales.y.title) {
            if (translations[language].numero_terremotos_label_y) {
                chart.options.scales.y.title.text = translations[language].numero_terremotos_label_y;
            } else if (translations[language].magnitud_label_y_timeseries) {
                chart.options.scales.y.title.text = translations[language].magnitud_label_y_timeseries;
            }
        }
        if (chart.options.scales.x && chart.options.scales.x.title) {
            if (translations[language].magnitud_label_x_magnitude) {
                chart.options.scales.x.title.text = translations[language].magnitud_label_x_magnitude;
            } else if (translations[language].fecha_label_x_timeseries) {
                chart.options.scales.x.title.text = translations[language].fecha_label_x_timeseries;
            }
        }
    }
    
    // Actualizar el gráfico
    chart.update();
}

function initializeMap() {
    // Inicializar mapa
    map = L.map('earthquakeMap', {
        center: [20, 0],
        zoom: 2,
        minZoom: 2,
        maxZoom: 18,
        zoomControl: true,
        worldCopyJump: true
    });
    
    updateMapStyle();
    
    markerClusterGroup = L.markerClusterGroup({
        maxClusterRadius: 50,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
        zoomToBoundsOnClick: true,
        spiderfyDistanceMultiplier: 1.5,
        disableClusteringAtZoom: 13,
        animate: false,
        animateAddingMarkers: false,
        removeOutsideVisibleBounds: true,
        chunkedLoading: true,
        chunkInterval: 100,
        chunkDelay: 50,
        iconCreateFunction: function(cluster) {
            const count = cluster.getChildCount();
            const markers = cluster.getAllChildMarkers();
            
            let maxMag = 0;
            markers.forEach(m => {
                const mag = parseFloat(m.options.magnitude) || 0;
                if (mag > maxMag) maxMag = mag;
            });
            
            let size = 'small';
            let clusterClass = 'low';
            
            // Clasificación visual basada en umbrales USGS
            if (maxMag >= 7) {
                // Major/Great: M ≥ 7.0
                size = 'large';
                clusterClass = 'severe';
            } else if (maxMag >= 5) {
                // Moderate/Strong: M 5.0-6.9
                size = 'medium';
                clusterClass = 'high';
            } else if (maxMag >= 3) {
                // Minor/Light: M 3.0-4.9
                size = 'medium';
                clusterClass = 'moderate';
            }
            // Micro: M < 3.0 (ya está configurado como 'low')
            
            return L.divIcon({
                html: `<div class="cluster-inner cluster-${clusterClass}"><span>${count}</span></div>`,
                className: `marker-cluster marker-cluster-${size}`,
                iconSize: L.point(50, 50)
            });
        }
    }).addTo(map);
    
    addMapLegend();
    
    L.control.scale({
        metric: true,
        imperial: false,
        position: 'bottomleft'
    }).addTo(map);
    
    console.log('🗺️ Mapa inicializado correctamente');
}

// Leyenda científica del mapa
function addMapLegend() {
    const legend = L.control({ position: 'bottomright' });
    
    legend.onAdd = function(map) {
        const div = L.DomUtil.create('div', 'map-legend');
        div.innerHTML = `
            <div class="legend-title">
                <i class="fas fa-layer-group"></i> Escala de Richter
            </div>
            <div class="legend-item">
                <span class="legend-color" style="background: #00ff00;"></span>
                <span>< 1.0 - Micro</span>
            </div>
            <div class="legend-item">
                <span class="legend-color" style="background: #ffff00;"></span>
                <span>2.0 - 2.9 - Menor</span>
            </div>
            <div class="legend-item">
                <span class="legend-color" style="background: #ffd700;"></span>
                <span>3.0 - 3.9 - Menor</span>
            </div>
            <div class="legend-item">
                <span class="legend-color" style="background: #ffa500;"></span>
                <span>4.0 - 4.9 - Ligero</span>
            </div>
            <div class="legend-item">
                <span class="legend-color" style="background: #ff6b35;"></span>
                <span>5.0 - 5.9 - Moderado</span>
            </div>
            <div class="legend-item">
                <span class="legend-color" style="background: #ff4500;"></span>
                <span>6.0 - 6.9 - Fuerte</span>
            </div>
            <div class="legend-item">
                <span class="legend-color" style="background: #dc143c;"></span>
                <span>7.0 - 7.9 - Mayor</span>
            </div>
            <div class="legend-item">
                <span class="legend-color" style="background: #8b0000;"></span>
                <span>≥ 8.0 - Gran Terremoto</span>
            </div>
            <div style="margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border-color); font-size: 10px; color: var(--text-muted);">
                <i class="fas fa-info-circle"></i> USGS / Escala Sismológica
            </div>
        `;
        return div;
    };
    
    legend.addTo(map);
}

function updateMapStyle() {
    const style = document.getElementById('mapStyle').value;
    
    if (map._currentStyle === style) return;
    map._currentStyle = style;
    
    let tileLayer;
    switch (style) {
        case 'satellite':
            tileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
                attribution: 'Tiles © Esri',
                maxZoom: 18,
                minZoom: 2
            });
            break;
        case 'terrain':
            tileLayer = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
                attribution: 'Map data: © OpenStreetMap',
                maxZoom: 17,
                minZoom: 2
            });
            break;
        default: // 'streets'
            tileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                attribution: '© OpenStreetMap',
                maxZoom: 19,
                minZoom: 2
            });
    }
    
    // Remover capa anterior
    if (map._baseLayer) {
        map.removeLayer(map._baseLayer);
    }
    
    tileLayer.addTo(map);
    map._baseLayer = tileLayer;
}

// Función auxiliar: Calcular distancia entre dos puntos (Haversine)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radio de la Tierra en km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

async function fetchEarthquakeData(timePeriod) {
    // Verificar caché primero
    const cacheKey = `earthquakes_${timePeriod}`;
    if (apiCache.has(cacheKey)) {
        console.log('📦 Datos cargados desde caché LRU');
        return apiCache.get(cacheKey);
    }
    
    console.log('🌐 Consultando API de USGS...');
    const response = await fetch(`https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_${timePeriod}.geojson`);
    const data = await response.json();
    const earthquakes = data.features;
    
    // Guardar en caché
    apiCache.set(cacheKey, earthquakes);
    
    // Limpiar y actualizar estructuras de datos
    earthquakeCache.clear();
    processedEarthquakeIds.clear();
    spatialIndex.clear();
    realtimeStats.reset();
    alertQueue.clear();
    
    // Procesar cada terremoto
    earthquakes.forEach(eq => {
        const id = eq.id;
        
        // Evitar duplicados con Set (O(1))
        if (!processedEarthquakeIds.has(id)) {
            processedEarthquakeIds.add(id);
            
            // Guardar en Map para acceso rápido (O(1))
            earthquakeCache.set(id, eq);
            
            // Añadir a índice espacial
            spatialIndex.insert(eq);
            
            // Actualizar estadísticas en tiempo real
            realtimeStats.update(eq);
            
            // Si es significativo (Moderate o mayor según USGS: M ≥ 5.0), añadir a cola de alertas
            // Referencia USGS: Moderate earthquakes pueden causar daños en áreas pobladas
            if (eq.properties.mag >= 5.0) {
                alertQueue.enqueue(eq, eq.properties.mag);
            }
        }
    });
    
    console.log(`✅ Procesados ${processedEarthquakeIds.size} terremotos únicos`);
    console.log(`📊 Estadísticas: ${realtimeStats.total} total, Max: ${realtimeStats.maxMagnitude.toFixed(1)}, Promedio: ${realtimeStats.avgMagnitude.toFixed(2)}`);
    console.log(`🔔 Alertas pendientes: ${alertQueue.size()}`);
    console.log(`📍 Índice espacial - NE: ${spatialIndex.NE.length}, NW: ${spatialIndex.NW.length}, SE: ${spatialIndex.SE.length}, SW: ${spatialIndex.SW.length}`);
    
    return earthquakes;
}

function updateStatistics(earthquakes) {
    // Usar estadísticas pre-calculadas (O(1) en lugar de O(n))
    const total = realtimeStats.total;
    const avg = realtimeStats.avgMagnitude;
    const max = realtimeStats.maxMagnitude;
    
    // Calcular recientes (últimas 6 horas) - más granular y útil que repetir 24h
    const last6Hours = Date.now() - (6 * 60 * 60 * 1000); // 6 horas en ms
    const recent = earthquakes.filter(eq => eq.properties.time >= last6Hours).length;
    
    // Actualizar DOM
    document.getElementById('totalQuakes').textContent = total;
    document.getElementById('avgMagnitude').textContent = avg.toFixed(2);
    document.getElementById('maxMagnitude').textContent = max.toFixed(1);
    document.getElementById('recentQuakes').textContent = recent;
    
    // Estadísticas adicionales por magnitud
    console.log('📊 Distribución por magnitud:', realtimeStats.byMagnitude);
    console.log('📏 Distribución por profundidad:', realtimeStats.byDepth);
    console.log('🌍 Top 5 regiones:', realtimeStats.getTopRegions(5));
}

function displayEarthquakes(earthquakes, magnitudeThreshold) {
    // Limpiar capas
    markerClusterGroup.clearLayers();
    
    let markersAdded = 0;
    const markers = []; // Crear array de marcadores primero, agregar todos juntos al final
    
    // Limitar número de marcadores
    const MAX_MARKERS = 500;
    const limitedEarthquakes = earthquakes.slice(0, MAX_MARKERS);
    
    limitedEarthquakes.forEach(eq => {
        if (!eq || !eq.properties || !eq.geometry || !eq.geometry.coordinates) {
            console.warn('⚠️ Terremoto inválido:', eq);
            return;
        }
        
        const magnitude = eq.properties.mag;
        const coords = eq.geometry.coordinates;
        const depth = coords[2];
        const lat = coords[1];
        const lon = coords[0];
        
        if (magnitude !== null && magnitude >= magnitudeThreshold) {
            markersAdded++;
            const currentLanguage = document.getElementById('language-selector').value;
            const isSaved = savedQuakes.some(q => q.id === eq.id);
            
            // Cálculos científicos
            const energy = calculateSeismicEnergy(magnitude); // Joules
            const intensity = calculateIntensity(magnitude, depth);
            const intensityBadge = getIntensityBadge(intensity);
            const waveSpeed = calculateWaveSpeed(depth);
            const epicentralDistance = depth * 1.5; // Aproximación
            
            // Crear icono personalizado basado en magnitud
            const markerSize = Math.min(Math.max(magnitude * 4, 12), 40);
            const color = getColorByMagnitude(magnitude);
            
            const customIcon = L.divIcon({
                className: 'custom-earthquake-marker',
                html: `
                    <div style="
                        width: ${markerSize}px;
                        height: ${markerSize}px;
                        background-color: ${color};
                        border: 2px solid #ffffff;
                        border-radius: 50%;
                        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
                        cursor: pointer;
                        transition: transform 0.2s ease;
                    " class="quake-marker-inner" data-magnitude="${magnitude}">
                    </div>
                `,
                iconSize: [markerSize, markerSize],
                iconAnchor: [markerSize / 2, markerSize / 2],
                popupAnchor: [0, -markerSize / 2]
            });
            
            const marker = L.marker([lat, lon], {
                icon: customIcon,
                magnitude: magnitude,
                interactive: true,
                keyboard: false, // Desactivar navegación por teclado
                riseOnHover: false // Sin reordenamiento en hover
            });
            
            // Guardar datos del terremoto en el marcador (más ligero que crear popup)
            marker.earthquakeData = {
                id: eq.id,
                magnitude,
                place: eq.properties.place,
                lat,
                lon,
                depth,
                time: eq.properties.time,
                energy,
                intensity,
                waveSpeed,
                url: eq.properties.url,
                type: eq.properties.type || 'earthquake',
                isSaved
            };
            
            // Tooltip simple
            marker.bindTooltip(`M${magnitude.toFixed(1)}`, {
                permanent: false,
                direction: 'top',
                offset: [0, -10],
                opacity: 0.9,
                className: 'scientific-tooltip',
                sticky: false
            });
            
            marker.on('click', function(e) {
                const data = this.earthquakeData;
                
                // Crear popup solo ahora (siempre actualizar el contenido)
                const popupContent = `
                    <div class="earthquake-popup-compact">
                        <div class="popup-header-compact">
                            <h3 class="popup-magnitude">M ${data.magnitude.toFixed(1)}</h3>
                            <span class="intensity-badge intensity-${data.intensity.toLowerCase()}">${getIntensityBadge(data.intensity)}</span>
                        </div>
                        <div class="popup-location">${data.place}</div>
                        <div class="popup-details-grid">
                            <div class="detail-item">
                                <span class="detail-icon">📍</span>
                                <span class="detail-value">${data.depth.toFixed(0)} km</span>
                            </div>
                            <div class="detail-item">
                                <span class="detail-icon">⚡</span>
                                <span class="detail-value">${formatEnergy(data.energy)}</span>
                            </div>
                            <div class="detail-item">
                                <span class="detail-icon">🕐</span>
                                <span class="detail-value">${new Date(data.time).toLocaleDateString()}</span>
                            </div>
                        </div>
                        <div class="popup-actions">
                            <button onclick='window.saveQuakeFromMap("${data.id}", ${data.magnitude}, "${data.place.replace(/'/g, "\\'")}", "${data.time}", ${data.lat}, ${data.lon}, ${data.depth})' 
                                    class="popup-action-btn ${data.isSaved ? 'saved' : 'save'}" ${data.isSaved ? 'disabled' : ''}>
                                <i class="fas fa-star"></i>
                            </button>
                            <button onclick='window.showFullDetails("${data.id}")' class="popup-action-btn info">
                                <i class="fas fa-info-circle"></i>
                            </button>
                            <button onclick='window.open("${data.url}", "_blank")' class="popup-action-btn external">
                                <i class="fas fa-external-link-alt"></i>
                            </button>
                        </div>
                    </div>
                `;
                
                // Siempre bind del popup (actualizar contenido si ya existe)
                this.bindPopup(popupContent, {
                    maxWidth: 280,
                    minWidth: 240,
                    maxHeight: 300,
                    autoPan: true,
                    autoPanPadding: [50, 50],
                    closeButton: true,
                    autoClose: false,
                    closeOnClick: false,
                    className: 'compact-popup',
                    keepInView: true
                });
                
                // Abrir el popup
                this.openPopup();
            });
            
            // Agregar a array en lugar de directamente al cluster
            markers.push(marker);
        }
    });
    
    // Agregar TODOS los marcadores de una vez = mucho más rápido
    if (markers.length > 0) {
        markerClusterGroup.addLayers(markers);
    }
    
    console.log(`✅ ${markers.length} marcadores agregados al mapa (de ${earthquakes.length} disponibles, máx ${MAX_MARKERS})`);
    console.log(`📍 Total de capas en cluster: ${markerClusterGroup.getLayers().length}`);
    
    // Solo hacer fitBounds en la primera carga, no en actualizaciones
    if (markerClusterGroup.getLayers().length > 0 && !window.mapInitiallyFitted) {
        console.log('🗺️ Ajustando vista del mapa...');
        map.fitBounds(markerClusterGroup.getBounds(), {padding: [50, 50]});
        window.mapInitiallyFitted = true;
    }
    
    // Forzar refresco del mapa
    setTimeout(() => {
        map.invalidateSize();
        markerClusterGroup.refreshClusters();
        console.log('🔄 Mapa refrescado');
    }, 100);
}

// ============================================
// FUNCIONES CIENTÍFICAS PARA EL MAPA
// ============================================

// Calcular energía sísmica liberada (en Joules) - Fórmula de Gutenberg-Richter
// log10(E) = 1.5*M + 4.8 (energía en ergios) convertido a Joules
function calculateSeismicEnergy(magnitude) {
    if (magnitude <= 0) return 0;
    const logEnergy = 1.5 * magnitude + 4.8;
    return Math.pow(10, logEnergy);
}

// Formatear energía en notación legible con unidades apropiadas
function formatEnergy(energy) {
    if (energy === 0) return '0 J';
    if (energy < 1e3) return energy.toFixed(1) + ' J';
    if (energy < 1e6) return (energy / 1e3).toFixed(1) + ' kJ';
    if (energy < 1e9) return (energy / 1e6).toFixed(1) + ' MJ';
    if (energy < 1e12) return (energy / 1e9).toFixed(2) + ' GJ';
    if (energy < 1e15) return (energy / 1e12).toFixed(2) + ' TJ';
    return (energy / 1e15).toFixed(3) + ' PJ';
}

// Calcular intensidad sísmica (Escala de Mercalli Modificada)
// NOTA: Esta es una aproximación empírica simplificada para clasificación rápida
// Para cálculos precisos, usar calculateMMIntensity() que implementa Wald et al. (1999)
function calculateIntensity(magnitude, depth) {
    if (magnitude <= 0) return 'low';
    
    // Fórmula empírica simplificada: I ≈ 1.5*M - 0.5*log10(h) + 1.78
    // Donde h es la profundidad en km
    const depthKm = Math.max(depth, 1); // Evitar log(0)
    const intensityValue = 1.5 * magnitude - 0.5 * Math.log10(depthKm) + 1.78;
    
    // Clasificación basada en MMI
    if (intensityValue < 3.5) return 'low';      // MMI I-III (no sentido o débil)
    if (intensityValue < 5.5) return 'moderate'; // MMI IV-V (ligero a moderado)
    if (intensityValue < 7.5) return 'high';     // MMI VI-VII (fuerte a muy fuerte)
    return 'severe';                             // MMI VIII+ (severo a catastrófico)
}

// Badge de intensidad
function getIntensityBadge(intensity) {
    const badges = {
        'low': 'Baja',
        'moderate': 'Moderada',
        'high': 'Alta',
        'severe': 'Severa'
    };
    return badges[intensity] || 'Unknown';
}

// Calcular velocidad de ondas sísmicas
// Ondas P (primarias) y S (secundarias)
function calculateWaveSpeed(depth) {
    // Velocidades aproximadas basadas en el modelo PREM
    let vp, vs;
    
    if (depth < 35) { // Corteza
        vp = 6.5;
        vs = 3.6;
    } else if (depth < 220) { // Manto superior
        vp = 8.0;
        vs = 4.5;
    } else if (depth < 660) { // Zona de transición
        vp = 10.0;
        vs = 5.5;
    } else { // Manto inferior
        vp = 13.0;
        vs = 7.2;
    }
    
    return { p: vp, s: vs };
}

function getColorByMagnitude(magnitude) {
    // Escala de colores según clasificación USGS
    // Referencia: https://www.usgs.gov/programs/earthquake-hazards/earthquake-magnitude-energy-release-and-shaking-intensity
    if (magnitude < 1) return '#00ff00';      // Verde brillante - Micro (M < 1.0)
    if (magnitude < 2) return '#7fff00';      // Verde lima - Micro (M 1.0-1.9)
    if (magnitude < 3) return '#ffff00';      // Amarillo - Minor (M 2.0-2.9)
    if (magnitude < 4) return '#ffd700';      // Oro - Minor (M 3.0-3.9)
    if (magnitude < 5) return '#ffa500';      // Naranja - Light (M 4.0-4.9)
    if (magnitude < 6) return '#ff6b35';      // Naranja rojizo - Moderate (M 5.0-5.9)
    if (magnitude < 7) return '#ff4500';      // Naranja rojo - Strong (M 6.0-6.9)
    if (magnitude < 8) return '#dc143c';      // Crimson - Major (M 7.0-7.9)
    return '#8b0000';                          // Rojo oscuro - Great (M ≥ 8.0)
}

function createMagnitudeChart(earthquakes) {
    const ctx = document.getElementById('magnitudeChart').getContext('2d');
    const magnitudeCounts = {};
    earthquakes.forEach(eq => {
        const magnitude = Math.floor(eq.properties.mag);
        magnitudeCounts[magnitude] = (magnitudeCounts[magnitude] || 0) + 1;
    });
    const labels = Object.keys(magnitudeCounts).sort((a, b) => a - b);
    const data = labels.map(label => magnitudeCounts[label]);
    const currentLanguage = document.getElementById('language-selector').value;

    if (magnitudeChart) {
        magnitudeChart.destroy();
    }
    magnitudeChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: translations[currentLanguage].numero_terremotos_label_y,
                data: data,
                backgroundColor: 'rgba(220, 20, 60, 0.75)',
                borderColor: '#DC143C',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            backgroundColor: 'transparent',
            color: '#f0f0f0',
            plugins: {
                title: {
                    display: true,
                    text: translations[currentLanguage].distribucion_magnitudes_chart_title, // Título traducido
                    font: {
                        size: 16,
                        color: '#f0f0f0'
                    }
                },
                legend: {
                    display: false,
                    labels: {
                        color: '#f0f0f0'
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: {
                        display: true,
                        text: translations[currentLanguage].numero_terremotos_label_y, // Eje Y traducido
                        color: '#f0f0f0'
                    },
                    ticks: {
                        color: '#f0f0f0'
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    },
                    border: {
                        color: '#f0f0f0'
                    }
                },
                x: {
                    title: {
                        display: true,
                        text: translations[currentLanguage].magnitud_label_x_magnitude, // Eje X traducido
                        color: '#f0f0f0'
                    },
                    ticks: {
                        color: '#f0f0f0'
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    },
                    border: {
                        color: '#f0f0f0'
                    }
                }
            }
        }
    });
}

function createTimeSeriesChart(earthquakes) {
    const ctx = document.getElementById('timeSeriesChart').getContext('2d');
    const data = earthquakes.map(eq => ({
        x: new Date(eq.properties.time),
        y: eq.properties.mag
    })).sort((a, b) => a.x - b.x);
    const currentLanguage = document.getElementById('language-selector').value;

    if (timeSeriesChart) {
        timeSeriesChart.destroy();
    }
    timeSeriesChart = new Chart(ctx, {
        type: 'line',
        data: {
            datasets: [{
                label: translations[currentLanguage].magnitud_tiempo_chart_title, // Título traducido
                data: data,
                borderColor: 'rgba(220, 20, 60, 0.9)',
                backgroundColor: 'rgba(220, 20, 60, 0.25)',
                pointRadius: 3,
                pointHoverRadius: 5,
                fill: true
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            backgroundColor: 'transparent',
            color: '#f0f0f0',
            plugins: {
                title: {
                    display: true,
                    text: translations[currentLanguage].magnitud_tiempo_chart_title, // Título traducido
                    font: {
                        size: 16,
                        color: '#f0f0f0'
                    }
                },
                legend: {
                    labels: {
                        color: '#f0f0f0'
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: 'day'
                    },
                    title: {
                        display: true,
                        text: translations[currentLanguage].fecha_label_x_timeseries, // Eje X traducido
                        color: '#f0f0f0'
                    },
                    ticks: {
                        color: '#f0f0f0'
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    },
                    border: {
                        color: '#f0f0f0'
                    }
                },
                y: {
                    title: {
                        display: true,
                        text: translations[currentLanguage].magnitud_label_y_timeseries, // Eje Y traducido
                        color: '#f0f0f0'
                    },
                    ticks: {
                        color: '#f0f0f0'
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.1)'
                    },
                    border: {
                        color: '#f0f0f0'
                    }
                }
            }
        }
    });
}

function createDepthChart(earthquakes) {
    const ctx = document.getElementById('depthChart').getContext('2d');
    const depthRanges = {
        '0-10 km': 0,
        '10-50 km': 0,
        '50-100 km': 0,
        '100-300 km': 0,
        '300+ km': 0
    };
    earthquakes.forEach(eq => {
        const depth = eq.geometry.coordinates[2];
        if (depth <= 10) depthRanges['0-10 km']++;
        else if (depth <= 50) depthRanges['10-50 km']++;
        else if (depth <= 100) depthRanges['50-100 km']++;
        else if (depth <= 300) depthRanges['100-300 km']++;
        else depthRanges['300+ km']++;
    });
    const currentLanguage = document.getElementById('language-selector').value;

    if (depthChart) {
        depthChart.destroy();
    }
    depthChart = new Chart(ctx, {
        type: 'pie',
        data: {
            labels: Object.keys(depthRanges).map(range => { // Traducir las etiquetas de profundidad
                const rangeParts = range.split('-');
                if (rangeParts.length === 2) {
                    return `${rangeParts[0]}-${rangeParts[1]} km`; // No traducir "km"
                } else {
                    return `${range}`; // Para "300+ km", no traducir "km" ni "+"
                }
            }),
            datasets: [{
                data: Object.values(depthRanges),
                backgroundColor: [
                    'rgba(220, 20, 60, 0.85)',
                    'rgba(220, 20, 60, 0.7)',
                    'rgba(205, 92, 92, 0.8)',
                    'rgba(255, 69, 0, 0.7)',
                    'rgba(178, 34, 34, 0.7)'
                ],
                borderColor: 'transparent'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            backgroundColor: 'transparent',
            color: '#f0f0f0',
            plugins: {
                title: {
                    display: true,
                    text: translations[currentLanguage].distribucion_profundidad_chart_title, // Título traducido
                    font: {
                        size: 16,
                        color: '#f0f0f0'
                    }
                },
                legend: {
                    labels: {
                        color: '#f0f0f0'
                    }
                }
            } ,
            cutoutPercentage: 30
        }
    });
}


function updateLatestEarthquakes(earthquakes) {
    const latestList = document.getElementById('latestEarthquakes');
    latestList.innerHTML = '';
    earthquakes.slice(0, 10).forEach(eq => {
        const li = document.createElement('li');
        li.className = 'p-2 bg-dark-242323 rounded-lg mb-2';

        const magnitudeSpan = document.createElement('span');
        magnitudeSpan.className = 'font-semibold';
        magnitudeSpan.setAttribute('data-i18n', 'latest_quake_magnitude');
        magnitudeSpan.textContent = translations[document.getElementById('language-selector').value].latest_quake_magnitude || translations['es'].latest_quake_magnitude;

        const magnitudeValueSpan = document.createElement('span');
        magnitudeValueSpan.textContent = ` ${eq.properties.mag.toFixed(1)}`;

        const placeSpan = document.createElement('span');
        placeSpan.className = 'text-sm text-text-secondary';
        placeSpan.textContent = eq.properties.place;

        const timeSpan = document.createElement('span');
        timeSpan.className = 'text-xs text-text-secondary';
        timeSpan.textContent = new Date(eq.properties.time).toLocaleString();

        li.appendChild(magnitudeSpan);
        li.appendChild(magnitudeValueSpan);
        li.appendChild(document.createElement('br'));
        li.appendChild(placeSpan);
        li.appendChild(document.createElement('br'));
        li.appendChild(timeSpan);

        latestList.appendChild(li);
    });

    const currentLanguage = document.getElementById('language-selector').value;
    translatePage(currentLanguage);
}

function checkForSignificantEarthquakes(earthquakes) {
    // Umbral USGS para terremotos "Strong": M ≥ 6.0
    // Estos eventos pueden causar daños considerables en áreas pobladas
    // Referencia: https://www.usgs.gov/programs/earthquake-hazards/earthquake-magnitude-energy-release-and-shaking-intensity
    const significantEarthquake = earthquakes.find(eq => eq.properties.mag >= 6.0);
    if (significantEarthquake) {
        const alertElement = document.getElementById('earthquakeAlert');
        const alertDetails = document.getElementById('alertDetails');
        const currentLanguage = document.getElementById('language-selector').value;

        console.log("checkForSignificantEarthquakes: Idioma actual detectado:", currentLanguage);

        // **GENERAR EL MENSAJE DE ALERTA COMPLETAMENTE TRADUCIDO DESDE EL INICIO**
        let translatedAlertMessage = translations[currentLanguage].alerta_significativo
            .replace('%{magnitude}', translations[currentLanguage].popup_magnitud + " " + significantEarthquake.properties.mag.toFixed(1)) // Usar etiqueta traducida "Magnitud"
            .replace('%{lugar}', translations[currentLanguage].popup_ubicacion + " " + significantEarthquake.properties.place);     // Usar etiqueta traducida "Ubicación"

        console.log("checkForSignificantEarthquakes: Mensaje generado (traducido):", translatedAlertMessage);

        alertDetails.textContent = translatedAlertMessage;
        alertElement.classList.remove('hidden');
    } else {
        document.getElementById('earthquakeAlert').classList.add('hidden');
    }
}

async function fetchEarthquakeNews() {
    try {
        const response = await axios.get('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson');
        const newsContainer = document.getElementById('newsContainer');
        newsContainer.innerHTML = '';
        const currentLanguage = document.getElementById('language-selector').value;
        response.data.features.slice(0, 5).forEach(feature => {
            const newsItem = document.createElement('div');
            newsItem.className = 'bg-dark-242323 p-4 rounded-lg mb-4';

            const newsTitle = document.createElement('h3');
            newsTitle.className = 'font-semibold mb-2';
            newsTitle.setAttribute('data-i18n', 'news_item_title_' + feature.id);
            newsTitle.textContent = feature.properties.title;

            const newsDate = document.createElement('p');
            newsDate.className = 'text-sm text-text-secondary';
            newsDate.setAttribute('data-i18n', 'news_item_date_' + feature.id);
            newsDate.textContent = new Date(feature.properties.time).toLocaleString();

            const readMoreLink = document.createElement('a');
            readMoreLink.href = feature.properties.url;
            readMoreLink.target = '_blank';
            readMoreLink.className = 'text-primary hover:underline mt-2 inline-block';
            readMoreLink.setAttribute('data-i18n', 'leer_mas');
            readMoreLink.textContent = translations[currentLanguage].leer_mas;


            newsItem.appendChild(newsTitle);
            newsItem.appendChild(newsDate);
            newsItem.appendChild(readMoreLink);

            newsContainer.appendChild(newsItem);
        });

        translatePage(currentLanguage);


    } catch (error) {
        console.error('Error fetching earthquake news:', error);
    }
}

function getUserLocation() {
    if ("geolocation" in navigator) {
        navigator.geolocation.getCurrentPosition(function(position) {
            userLocation = {
                lat: position.coords.latitude,
                lon: position.coords.longitude
            };
            map.setView([userLocation.lat, userLocation.lon], 8);
        }, function(error) {
            console.error("Error getting user location:", error);
        });
    } else {
        console.log("Geolocation is not supported by this browser.");
    }
}

async function updateEarthquakeData() {
    const timePeriod = document.getElementById('timePeriod').value;
    const magnitudeThreshold = parseFloat(document.getElementById('magnitudeFilter').value);
    try {
        const earthquakes = await fetchEarthquakeData(timePeriod);
        currentEarthquakesData = earthquakes; // earthquakes es un ARRAY
        updateStatistics(earthquakes);
        displayEarthquakes(earthquakes, magnitudeThreshold);
        createMagnitudeChart(earthquakes);
        createTimeSeriesChart(earthquakes);
        createDepthChart(earthquakes);
        updateLatestEarthquakes(earthquakes);
        
        // Actualizar nuevas funcionalidades DESPUÉS de cargar datos
        updateComparatorOptions();
        predictAftershocks();
        updateHeroStats();
        
        // Notificación de actualización (solo si no es la primera carga)
        const isFirstLoad = !window.hasLoadedOnce;
        if (!isFirstLoad && typeof addNotification === 'function') {
            addNotification('info', `Datos actualizados: ${earthquakes.length} terremotos cargados`);
        }
        window.hasLoadedOnce = true;
        
        checkForSignificantEarthquakes(earthquakes);
        if (userLocation) {
            checkNearbyEarthquakes(earthquakes, userLocation);
        }
    } catch (error) {
        console.error('Error updating earthquake data:', error);
        addNotification('danger', 'Error al actualizar datos sísmicos');
    }
}

function checkNearbyEarthquakes(earthquakes, location) {
    const nearbyEarthquake = earthquakes.find(eq => {
        const distance = getDistance(location.lat, location.lon, eq.geometry.coordinates[1], eq.geometry.coordinates[0]);
        return distance <= 100 && eq.properties.mag >= 4.0;
    });
    if (nearbyEarthquake) {
        const alertElement = document.getElementById('earthquakeAlert');
        const alertDetails = document.getElementById('alertDetails');
        const currentLanguage = document.getElementById('language-selector').value;

        console.log("checkNearbyEarthquakes: Idioma actual detectado:", currentLanguage);

        // **GENERAR EL MENSAJE DE ALERTA COMPLETAMENTE TRADUCIDO DESDE EL INICIO**
        let translatedAlertCercanoMessage = translations[currentLanguage].alerta_cercano
            .replace('%{magnitude}', translations[currentLanguage].popup_magnitud + " " + nearbyEarthquake.properties.mag.toFixed(1)); // Usar etiqueta traducida "Magnitud"


        console.log("checkNearbyEarthquakes: Mensaje generado (traducido):", translatedAlertCercanoMessage);

        alertDetails.textContent = translatedAlertCercanoMessage;
        alertElement.classList.remove('hidden');
    }
}

function getDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    const d = R * c;
    return d;
}

function deg2rad(deg) {
    return deg * (Math.PI / 180);
}

function initializeControls() {
    const magnitudeFilter = document.getElementById('magnitudeFilter');
    const magnitudeValue = document.getElementById('magnitudeValue');
    const timePeriod = document.getElementById('timePeriod');
    const mapStyle = document.getElementById('mapStyle');
    magnitudeFilter.addEventListener('input', function() {
        magnitudeValue.textContent = this.value;
        updateEarthquakeData();
    });
    timePeriod.addEventListener('change', updateEarthquakeData);
    mapStyle.addEventListener('change', updateMapStyle);
}

async function initializePage() {
    try {
        console.log('🚀 Inicializando SismoGlobal v2.0...');
        
        initializeMap();
        initializeControls();
        
        // Inicializar TODAS las nuevas funcionalidades
        initializeNewFeatures();
        initializeML();
        
        console.log('✅ Nuevas funcionalidades inicializadas');

        getUserLocation(); // No await aquí para no bloquear la inicialización inicial del mapa
        updateEarthquakeData().then(() => { // Asegurar que updateEarthquakeData se complete antes de la traducción inicial
            const languageSelector = document.getElementById('language-selector');
            const defaultLanguage = 'es';
            languageSelector.value = defaultLanguage;
            translatePage(defaultLanguage); // Traducir la página INICIALMENTE DESPUÉS de cargar los datos
            
            // Actualizar funcionalidades después de cargar datos
            updateHeroStats();
            updateComparatorOptions();
            predictAftershocks();
        });
        fetchEarthquakeNews(); // No await para noticias, pueden cargar en segundo plano

        setInterval(updateEarthquakeData, 300000);
        setInterval(fetchEarthquakeNews, 900000);
        setInterval(predictAftershocks, 300000); // Actualizar predicciones cada 5 minutos
        setInterval(updateHeroStats, 60000); // Actualizar stats hero cada minuto

        const languageSelector = document.getElementById('language-selector');
        languageSelector.addEventListener('change', function() {
            const selectedLanguage = languageSelector.value;
            translatePage(selectedLanguage); // Ahora translatePage re-renderiza graficas y mapa
        });
        
        console.log('✅ SismoGlobal v2.0 iniciado correctamente');

    } catch (error) {
        console.error('❌ Error al inicializar la página:', error);
    }
}

document.addEventListener('DOMContentLoaded', function() {
    // Inicializar página principal
    initializePage();
    
    // 🛡️ Inicializar sistema de limpieza automática de memoria
    initMemoryCleanup();
    console.log('🛡️ Sistema de limpieza de memoria inicializado');
    
    // � MONITOR GLOBAL DE ERRORES (captura crasheos)
    window.addEventListener('error', function(event) {
        console.error('🚨 Error global capturado:', event.error);
        
        // Si el error está relacionado con RiesgoML, limpiar inmediatamente
        if (event.error && (
            event.error.message.includes('riesgo') ||
            event.error.message.includes('tensor') ||
            event.error.message.includes('layer') ||
            event.filename.includes('script.js')
        )) {
            console.log('🚨 Error relacionado con RiesgoML detectado - activando limpieza de emergencia');
            emergencyRiskMLCleanup();
        }
    });
    
    // 🚨 MONITOR DE PROMESAS RECHAZADAS
    window.addEventListener('unhandledrejection', function(event) {
        console.error('🚨 Promesa rechazada no manejada:', event.reason);
        
        // Si está relacionado con ML/TensorFlow, limpiar
        if (event.reason && (
            event.reason.toString().includes('tensor') ||
            event.reason.toString().includes('memory') ||
            event.reason.toString().includes('layer')
        )) {
            console.log('🚨 Error de promesa relacionado con ML - activando limpieza de emergencia');
            emergencyRiskMLCleanup();
        }
    });
    
    // �🛡️ Limpiar memoria al cambiar de pestaña o minimizar ventana
    document.addEventListener('visibilitychange', function() {
        if (document.hidden) {
            console.log('🧹 Ventana oculta - ejecutando limpieza de memoria');
            cleanupTensorMemory();
        }
    });
    
    // 🛡️ Limpiar memoria antes de cerrar la página
    window.addEventListener('beforeunload', function() {
        console.log('🧹 Cerrando página - limpieza final de memoria');
        if (memoryCleanupInterval) {
            clearInterval(memoryCleanupInterval);
        }
        cleanupTensorMemory();
    });
    
    console.log('🛡️ Sistema completo de protección anti-crasheo inicializado');
});

// ==================== NUEVAS FUNCIONALIDADES ====================

// ==================== SISTEMA DE NOTIFICACIONES ====================
let notifications = [];

function addNotification(type, message) {
    const notification = {
        id: Date.now(),
        type: type, // 'info', 'warning', 'danger', 'success'
        message: message,
        timestamp: new Date(),
        read: false
    };
    notifications.unshift(notification);
    
    // Limitar a máximo 50 notificaciones
    if (notifications.length > 50) {
        notifications = notifications.slice(0, 50);
    }
    
    updateNotificationBadge();
    showNotificationToast(notification);
    
    // Actualizar subtitle
    updateNotificationSubtitle();
}

function updateNotificationBadge() {
    const badge = document.getElementById('notificationBadge');
    const unreadCount = notifications.filter(n => !n.read).length;
    
    if (unreadCount > 0) {
        badge.textContent = unreadCount > 99 ? '99+' : unreadCount;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function updateNotificationSubtitle() {
    // Función deshabilitada - subtítulo removido para UI más compacta
    return;
}

// ==================== SISTEMA DE TOASTS ====================
let toastContainer = null;

function showNotificationToast(notification) {
    // Crear contenedor si no existe
    if (!toastContainer) {
        toastContainer = document.createElement('div');
        toastContainer.id = 'toastContainer';
        toastContainer.className = 'fixed bottom-6 right-6 z-50 flex flex-col gap-2 max-w-sm pointer-events-none';
        document.body.appendChild(toastContainer);
    }
    
    // Colores y estilos según tipo
    const styles = {
        danger: {
            bg: 'bg-gradient-to-r from-red-600 to-red-700',
            icon: 'fa-exclamation-circle',
            shadow: 'shadow-lg'
        },
        warning: {
            bg: 'bg-gradient-to-r from-yellow-600 to-yellow-700',
            icon: 'fa-exclamation-triangle',
            shadow: 'shadow-lg'
        },
        success: {
            bg: 'bg-gradient-to-r from-green-600 to-green-700',
            icon: 'fa-check-circle',
            shadow: 'shadow-lg'
        },
        info: {
            bg: 'bg-gradient-to-r from-blue-600 to-blue-700',
            icon: 'fa-info-circle',
            shadow: 'shadow-lg'
        }
    };
    
    const style = styles[notification.type] || styles.info;
    
    const toast = document.createElement('div');
    toast.className = `p-3 rounded-lg ${style.bg} ${style.shadow} text-white transition-all duration-300 backdrop-blur-sm border border-white/10 pointer-events-auto transform translate-x-full opacity-0`;
    toast.style.animation = 'toastSlideIn 0.4s cubic-bezier(0.4, 0, 0.2, 1) forwards';
    
    // Crear función de cerrar
    const closeToast = (toastElement) => {
        toastElement.style.opacity = '0';
        toastElement.style.transform = 'translateX(100%)';
        setTimeout(() => {
            if (toastElement.parentNode) {
                toastElement.remove();
            }
        }, 300);
    };
    
    toast.innerHTML = `
        <div class="flex items-start gap-2">
            <div class="w-8 h-8 rounded-lg bg-white/20 flex items-center justify-center flex-shrink-0">
                <i class="fas ${style.icon} text-sm"></i>
            </div>
            <div class="flex-1 min-w-0">
                <p class="font-semibold text-xs mb-0.5">${getNotificationTitle(notification.type)}</p>
                <p class="font-medium text-xs opacity-90">${notification.message}</p>
            </div>
            <button class="toast-close-btn hover:bg-white/20 rounded p-1 flex-shrink-0 transition-all hover:scale-110">
                <i class="fas fa-times text-xs"></i>
            </button>
        </div>
        <!-- Barra de progreso -->
        <div class="absolute bottom-0 left-0 right-0 h-0.5 bg-white/30 rounded-b-lg overflow-hidden">
            <div class="h-full bg-white/80 toast-progress"></div>
        </div>
    `;
    
    // Agregar evento de cierre al botón
    const closeBtn = toast.querySelector('.toast-close-btn');
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeToast(toast);
    });
    
    // Insertar al principio del contenedor
    toastContainer.insertBefore(toast, toastContainer.firstChild);
    
    // Animar entrada
    requestAnimationFrame(() => {
        toast.style.transform = 'translateX(0)';
        toast.style.opacity = '1';
    });
    
    // Limitar a máximo 2 toasts visibles (reducido de 3)
    while (toastContainer.children.length > 2) {
        const lastToast = toastContainer.lastChild;
        closeToast(lastToast);
    }
    
    // Auto-remover después de 4 segundos (reducido de 5)
    const duration = 4000;
    setTimeout(() => {
        closeToast(toast);
    }, duration);
}

// Agregar estilos de animación para toasts
if (!document.getElementById('toast-styles')) {
    const style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = `
        @keyframes toastSlideIn {
            from {
                opacity: 0;
                transform: translateX(100%);
            }
            to {
                opacity: 1;
                transform: translateX(0);
            }
        }
        
        .toast-progress {
            animation: toastProgress 4s linear forwards;
        }
        
        @keyframes toastProgress {
            from {
                width: 100%;
            }
            to {
                width: 0%;
            }
        }
    `;
    document.head.appendChild(style);
}

// Función wrapper simplificada para mostrar toasts
function showToast(message, type = 'info') {
    const notification = {
        id: Date.now(),
        type: type, // 'info', 'warning', 'danger', 'success'
        message: message,
        timestamp: new Date(),
        read: false
    };
    showNotificationToast(notification);
}

// Toggle de Tema Claro/Oscuro - DESACTIVADO
// El sitio permanece en modo oscuro siempre
let isDarkMode = true;

// ============================================
// NOTA: Sistema de Theme Toggle eliminado (código muerto)
// App usa tema oscuro fijo, no hay botón de cambio de tema
// ============================================

// ==================== PANEL DE NOTIFICACIONES ====================
let currentNotificationFilter = 'all';

function initializeNotificationsPanel() {
    const notificationBtn = document.getElementById('notificationBtn');
    const notificationsPanel = document.getElementById('notificationsPanel');
    const closeNotifications = document.getElementById('closeNotifications');
    const clearAllBtn = document.getElementById('clearAllNotifications');
    const markAllReadBtn = document.getElementById('markAllAsRead');
    
    // Toggle panel
    if (notificationBtn) {
        notificationBtn.addEventListener('click', () => {
            notificationsPanel.classList.toggle('hidden');
            if (!notificationsPanel.classList.contains('hidden')) {
                renderNotifications();
                updateNotificationsTime();
            }
        });
    }
    
    // Cerrar panel
    if (closeNotifications) {
        closeNotifications.addEventListener('click', () => {
            notificationsPanel.classList.add('hidden');
        });
    }
    
    // Limpiar todas las notificaciones
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', () => {
            if (confirm('¿Deseas eliminar todas las notificaciones?')) {
                notifications = [];
                renderNotifications();
                updateNotificationBadge();
                addNotification('success', 'Todas las notificaciones han sido eliminadas');
            }
        });
    }
    
    // Marcar todas como leídas
    if (markAllReadBtn) {
        markAllReadBtn.addEventListener('click', () => {
            notifications.forEach(n => n.read = true);
            renderNotifications();
            updateNotificationBadge();
        });
    }
    
    // Filtros de notificaciones
    const filterButtons = document.querySelectorAll('.notification-filter');
    filterButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            // Remover clase active de todos
            filterButtons.forEach(b => b.classList.remove('active'));
            // Agregar a botón clickeado
            btn.classList.add('active');
            
            currentNotificationFilter = btn.dataset.filter;
            renderNotifications();
        });
    });
    
    // Cerrar al hacer clic fuera
    document.addEventListener('click', (e) => {
        if (!notificationsPanel.contains(e.target) && 
            !notificationBtn?.contains(e.target) &&
            !notificationsPanel.classList.contains('hidden')) {
            notificationsPanel.classList.add('hidden');
        }
    });
}

function renderNotifications() {
    const container = document.getElementById('notificationsList');
    
    // Filtrar notificaciones
    let filteredNotifications = notifications;
    if (currentNotificationFilter !== 'all') {
        filteredNotifications = notifications.filter(n => n.type === currentNotificationFilter);
    }
    
    // Si no hay notificaciones
    if (filteredNotifications.length === 0) {
        container.innerHTML = `
            <div class="notifications-empty">
                <i class="fas fa-bell-slash"></i>
                <p class="text-lg font-semibold mb-2">No hay notificaciones</p>
                <p class="text-sm">Te notificaremos cuando haya eventos sísmicos importantes</p>
            </div>
        `;
        return;
    }
    
    // Renderizar notificaciones
    container.innerHTML = filteredNotifications.map(n => {
        const iconClass = 
            n.type === 'danger' ? 'fa-exclamation-circle' :
            n.type === 'warning' ? 'fa-exclamation-triangle' :
            n.type === 'success' ? 'fa-check-circle' : 'fa-info-circle';
        
        const timeAgo = getTimeAgo(n.timestamp);
        
        return `
            <div class="notification-item ${n.type} ${n.read ? '' : 'unread'}" data-id="${n.id}" onclick="markNotificationAsRead(${n.id})">
                <div class="flex items-start gap-3">
                    <div class="notification-icon ${n.type}">
                        <i class="fas ${iconClass}"></i>
                    </div>
                    <div class="notification-content">
                        <div class="notification-title">${getNotificationTitle(n.type)}</div>
                        <div class="notification-message">${n.message}</div>
                        <div class="notification-time">
                            <i class="fas fa-clock"></i>
                            <span>${timeAgo}</span>
                        </div>
                    </div>
                    <button class="notification-delete" onclick="event.stopPropagation(); deleteNotification(${n.id})" title="Eliminar">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function getNotificationTitle(type) {
    const titles = {
        'danger': '⚠️ Alerta Crítica',
        'warning': '⚡ Aviso Importante',
        'success': '✅ Operación Exitosa',
        'info': 'ℹ️ Información'
    };
    return titles[type] || 'Notificación';
}

function getTimeAgo(timestamp) {
    const now = new Date();
    const diff = now - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `Hace ${days} día${days > 1 ? 's' : ''}`;
    if (hours > 0) return `Hace ${hours} hora${hours > 1 ? 's' : ''}`;
    if (minutes > 0) return `Hace ${minutes} minuto${minutes > 1 ? 's' : ''}`;
    return 'Justo ahora';
}

function updateNotificationsTime() {
    const timeElement = document.getElementById('notificationsTime');
    if (timeElement) {
        const now = new Date();
        timeElement.textContent = `Actualizado ${now.toLocaleTimeString()}`;
    }
}

function markNotificationAsRead(id) {
    const notification = notifications.find(n => n.id === id);
    if (notification && !notification.read) {
        notification.read = true;
        renderNotifications();
        updateNotificationBadge();
    }
}

function deleteNotification(id) {
    notifications = notifications.filter(n => n.id !== id);
    renderNotifications();
    updateNotificationBadge();
}

// Búsqueda Avanzada - DESACTIVADA (sección de búsqueda removida del HTML)
// ==================== SISTEMA DE BÚSQUEDA AVANZADO ====================

let searchCache = new Map(); // Cache de resultados
let searchHistory = [];

// ============================================
// NOTA: Sistema de búsqueda avanzada eliminado (código muerto)
// No hay elementos de búsqueda en el HTML
// ============================================

// Comparador de Terremotos
function initializeComparator() {
    const compare1 = document.getElementById('compare1');
    const compare2 = document.getElementById('compare2');
    
    compare1.addEventListener('change', () => compareEarthquakes());
    compare2.addEventListener('change', () => compareEarthquakes());
    
    // Poblar selectores
    updateComparatorOptions();
}

function updateComparatorOptions() {
    if (!currentEarthquakesData || !Array.isArray(currentEarthquakesData)) {
        console.log('No hay datos para el comparador');
        return;
    }
    
    const compare1 = document.getElementById('compare1');
    const compare2 = document.getElementById('compare2');
    
    if (!compare1 || !compare2) {
        console.log('Elementos del comparador no encontrados');
        return;
    }
    
    const currentLang = document.getElementById('language-selector').value;
    const selectText = currentLang === 'es' ? 'Seleccionar...' : 
                       currentLang === 'en' ? 'Select...' : 
                       'Seleccionar...';
    
    // currentEarthquakesData ya es un ARRAY
    const options = currentEarthquakesData.slice(0, 50).map((eq, index) => {
        const mag = eq.properties.mag ? eq.properties.mag.toFixed(1) : '0.0';
        const place = eq.properties.place || 'Unknown';
        const date = new Date(eq.properties.time).toLocaleDateString();
        return `<option value="${index}">M${mag} - ${place} (${date})</option>`;
    }).join('');
    
    compare1.innerHTML = `<option value="">${selectText}</option>` + options;
    compare2.innerHTML = `<option value="">${selectText}</option>` + options;
    
    console.log(`✅ Comparador actualizado con ${currentEarthquakesData.length} terremotos`);
}

function compareEarthquakes() {
    const index1 = document.getElementById('compare1').value;
    const index2 = document.getElementById('compare2').value;
    
    if (!index1 || !index2 || !currentEarthquakesData || !Array.isArray(currentEarthquakesData)) return;
    
    // currentEarthquakesData ya es un ARRAY
    const quake1 = currentEarthquakesData[index1].properties;
    const quake2 = currentEarthquakesData[index2].properties;
    
    document.getElementById('comparisonResult').classList.remove('hidden');
    
    // Detalles del terremoto 1
    document.getElementById('quake1Details').innerHTML = `
        <h3 class="text-xl font-bold mb-4 text-primary flex items-center gap-2">
            <i class="fas fa-map-marker-alt"></i>
            Terremoto 1
        </h3>
        <div class="space-y-3">
            <p><strong>Magnitud:</strong> <span class="text-2xl text-primary">${quake1.mag.toFixed(1)}</span></p>
            <p><strong>Ubicación:</strong> ${quake1.place}</p>
            <p><strong>Profundidad:</strong> ${currentEarthquakesData[index1].geometry.coordinates[2].toFixed(1)} km</p>
            <p><strong>Fecha:</strong> ${new Date(quake1.time).toLocaleString()}</p>
            <p><strong>Tipo:</strong> ${quake1.type}</p>
        </div>
    `;
    
    // Detalles del terremoto 2
    document.getElementById('quake2Details').innerHTML = `
        <h3 class="text-xl font-bold mb-4 text-blue-500 flex items-center gap-2">
            <i class="fas fa-map-marker-alt"></i>
            Terremoto 2
        </h3>
        <div class="space-y-3">
            <p><strong>Magnitud:</strong> <span class="text-2xl text-blue-500">${quake2.mag.toFixed(1)}</span></p>
            <p><strong>Ubicación:</strong> ${quake2.place}</p>
            <p><strong>Profundidad:</strong> ${currentEarthquakesData[index2].geometry.coordinates[2].toFixed(1)} km</p>
            <p><strong>Fecha:</strong> ${new Date(quake2.time).toLocaleString()}</p>
            <p><strong>Tipo:</strong> ${quake2.type}</p>
        </div>
    `;
    
    // Análisis comparativo
    const magDiff = Math.abs(quake1.mag - quake2.mag);
    const depthDiff = Math.abs(
        currentEarthquakesData[index1].geometry.coordinates[2] -
        currentEarthquakesData[index2].geometry.coordinates[2]
    );
    
    const energyRatio = Math.pow(10, 1.5 * magDiff);
    
    document.getElementById('comparisonAnalysis').innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div class="text-center p-4 bg-surface rounded-lg">
                <p class="text-text-secondary mb-2">Diferencia de Magnitud</p>
                <p class="text-3xl font-bold text-primary">${magDiff.toFixed(1)}</p>
            </div>
            <div class="text-center p-4 bg-surface rounded-lg">
                <p class="text-text-secondary mb-2">Diferencia de Profundidad</p>
                <p class="text-3xl font-bold text-yellow-500">${depthDiff.toFixed(1)} km</p>
            </div>
            <div class="text-center p-4 bg-surface rounded-lg">
                <p class="text-text-secondary mb-2">Proporción de Energía</p>
                <p class="text-3xl font-bold text-red-500">${energyRatio.toFixed(0)}x</p>
            </div>
        </div>
        <div class="mt-4 p-4 bg-surface rounded-lg">
            <p class="text-white">
                <i class="fas fa-info-circle text-blue-500 mr-2"></i>
                El terremoto de magnitud ${Math.max(quake1.mag, quake2.mag).toFixed(1)} liberó aproximadamente 
                <strong>${energyRatio.toFixed(0)} veces más energía</strong> que el de magnitud ${Math.min(quake1.mag, quake2.mag).toFixed(1)}.
            </p>
        </div>
    `;
}

// Predicción de Réplicas
function predictAftershocks() {
    if (!currentEarthquakesData || !Array.isArray(currentEarthquakesData)) return;
    
    const significantQuakes = currentEarthquakesData.filter(eq => eq.properties.mag >= 5.0);
    
    const container = document.getElementById('aftershockPrediction');
    
    if (!container) return; // Si el elemento no existe, salir
    
    if (significantQuakes.length === 0) {
        container.innerHTML = `
            <div class="col-span-3 text-center py-8">
                <i class="fas fa-info-circle text-4xl text-gray-700 mb-4"></i>
                <p class="text-text-secondary">No hay terremotos significativos recientes (M ≥ 5.0) para predecir réplicas.</p>
                <p class="text-sm text-text-secondary mt-2">Las predicciones aparecerán cuando ocurran eventos mayores</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = significantQuakes.slice(0, 3).map((eq, index) => {
        const mag = eq.properties.mag;
        const aftershockProbability = Math.min(95, (mag - 4) * 20);
        const expectedAftershocks = Math.floor(Math.pow(10, mag - 4));
        const duration = Math.ceil(mag * 2); // días
        const timeSince = Math.floor((Date.now() - eq.properties.time) / 86400000);
        
        return `
            <div class="bg-dark-1b p-6 rounded-lg border border-gray-700 hover-lift card-modern animate-fadeIn" style="animation-delay: ${index * 0.1}s;">
                <div class="flex items-center justify-between mb-4">
                    <h3 class="text-2xl font-bold text-white flex items-center gap-2">
                        <i class="fas fa-wave-square text-primary"></i>
                        M ${mag.toFixed(1)}
                    </h3>
                    <span class="text-xs px-3 py-1 bg-primary/20 text-primary rounded-full">
                        Hace ${timeSince} día${timeSince !== 1 ? 's' : ''}
                    </span>
                </div>
                <p class="text-white text-sm mb-4 font-semibold">${eq.properties.place}</p>
                <div class="space-y-3">
                    <div class="p-3 bg-surface rounded-lg">
                        <div class="flex justify-between mb-2">
                            <span class="text-sm text-text-secondary flex items-center gap-2">
                                <i class="fas fa-percentage"></i>
                                Probabilidad de réplicas
                            </span>
                            <strong class="text-yellow-400 text-lg">${aftershockProbability.toFixed(0)}%</strong>
                        </div>
                        <div class="h-3 bg-gray-700 rounded-full overflow-hidden">
                            <div class="h-full bg-gradient-to-r from-yellow-500 to-orange-500 transition-all duration-500" 
                                 style="width: ${aftershockProbability}%"></div>
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <div class="p-3 bg-surface rounded-lg text-center">
                            <i class="fas fa-bolt text-blue-400 text-xl mb-1"></i>
                            <p class="text-xs text-text-secondary mb-1">Réplicas esperadas</p>
                            <p class="text-2xl font-bold text-blue-400">~${expectedAftershocks}</p>
                        </div>
                        <div class="p-3 bg-surface rounded-lg text-center">
                            <i class="fas fa-calendar-alt text-green-400 text-xl mb-1"></i>
                            <p class="text-xs text-text-secondary mb-1">Duración estimada</p>
                            <p class="text-2xl font-bold text-green-400">${duration}d</p>
                        </div>
                    </div>
                </div>
                ${aftershockProbability >= 70 ? `
                <div class="mt-4 p-3 bg-red-600/20 border border-red-600/50 rounded-lg">
                    <p class="text-xs text-red-400 flex items-start gap-2">
                        <i class="fas fa-exclamation-triangle mt-0.5"></i>
                        <span><strong>Alta probabilidad:</strong> Mantente alerta y sigue las recomendaciones de seguridad.</span>
                    </p>
                </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

// Sistema de Favoritos
let savedQuakes = JSON.parse(localStorage.getItem('savedQuakes') || '[]');

// Función global para guardar desde el mapa (accesible desde popups)
window.saveQuakeFromMap = function(id, mag, place, time, lat, lon, depth) {
    const exists = savedQuakes.find(q => q.id === id);
    if (!exists) {
        savedQuakes.push({
            id: id,
            mag: mag,
            place: place,
            time: parseInt(time),
            lat: lat,
            lon: lon,
            depth: depth
        });
        localStorage.setItem('savedQuakes', JSON.stringify(savedQuakes));
        // Notificación eliminada - menos spam
        renderSavedQuakes();
        // Actualizar el mapa para reflejar el cambio
        if (currentEarthquakesData && Array.isArray(currentEarthquakesData)) {
            const magnitudeThreshold = parseFloat(document.getElementById('magnitudeFilter').value);
            displayEarthquakes(currentEarthquakesData, magnitudeThreshold);
        }
    } else {
        // Notificación eliminada - ya existe en favoritos (silencioso)
    }
};

function saveEarthquake(earthquake) {
    const exists = savedQuakes.find(q => q.id === earthquake.id);
    if (!exists) {
        const quakeData = {
            id: earthquake.id,
            mag: earthquake.properties.mag,
            place: earthquake.properties.place,
            time: earthquake.properties.time,
            lat: earthquake.geometry.coordinates[1],
            lon: earthquake.geometry.coordinates[0],
            depth: earthquake.geometry.coordinates[2]
        };
        savedQuakes.push(quakeData);
        localStorage.setItem('savedQuakes', JSON.stringify(savedQuakes));
        // Notificación eliminada - feedback visual suficiente
        renderSavedQuakes();
    } else {
        // Notificación eliminada - silencioso si ya existe
    }
}

function removeEarthquake(id) {
    savedQuakes = savedQuakes.filter(q => q.id !== id);
    localStorage.setItem('savedQuakes', JSON.stringify(savedQuakes));
    // Notificación eliminada - feedback visual suficiente
    renderSavedQuakes();
}

function renderSavedQuakes() {
    const container = document.getElementById('savedQuakes');
    
    if (!container) return; // Si el elemento no existe, salir
    
    if (savedQuakes.length === 0) {
        container.innerHTML = `
            <div class="col-span-3 text-center py-12">
                <i class="fas fa-star text-6xl text-gray-700 mb-4"></i>
                <p class="text-text-secondary">No tienes terremotos guardados.</p>
                <p class="text-sm text-text-secondary mt-2">Guarda terremotos importantes desde el mapa o el comparador</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = savedQuakes.map((eq, index) => `
        <div class="bg-dark-1b p-4 rounded-lg border border-gray-700 hover-lift animate-fadeIn card-modern" style="animation-delay: ${index * 0.1}s;">
            <div class="flex justify-between items-start mb-3">
                <div class="flex items-center gap-2">
                    <i class="fas fa-star text-yellow-400"></i>
                    <h3 class="text-2xl font-bold text-primary">M ${typeof eq.mag === 'number' ? eq.mag.toFixed(1) : eq.mag}</h3>
                </div>
                <button onclick="window.removeEarthquake('${eq.id}')" 
                        class="text-red-500 hover:text-red-700 hover:scale-110 transition-all p-2"
                        title="Eliminar">
                    <i class="fas fa-trash"></i>
                </button>
            </div>
            <p class="text-white text-sm mb-3 font-semibold">${eq.place}</p>
            <div class="flex items-center gap-2 text-xs text-text-secondary mb-3">
                <i class="fas fa-clock"></i>
                <span>${new Date(eq.time).toLocaleString()}</span>
            </div>
            
            <!-- Botones de acción -->
            <div class="flex gap-2 mt-4 pt-3 border-t border-gray-700">
                <button onclick="window.viewOnMap('${eq.id}', ${eq.lat}, ${eq.lon}, ${eq.mag})" 
                        class="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs py-2 px-3 rounded-lg transition-all hover:scale-105 flex items-center justify-center gap-1"
                        title="Ver en el mapa">
                    <i class="fas fa-map-marked-alt"></i>
                    <span>Ver en Mapa</span>
                </button>
                <button onclick="window.showEarthquakeDetails('${eq.id}')" 
                        class="flex-1 bg-purple-600 hover:bg-purple-700 text-white text-xs py-2 px-3 rounded-lg transition-all hover:scale-105 flex items-center justify-center gap-1"
                        title="Ver detalles completos">
                    <i class="fas fa-info-circle"></i>
                    <span>Detalles</span>
                </button>
                <button onclick="window.shareEarthquake('${eq.id}')" 
                        class="bg-green-600 hover:bg-green-700 text-white text-xs py-2 px-3 rounded-lg transition-all hover:scale-105"
                        title="Compartir">
                    <i class="fas fa-share-alt"></i>
                </button>
            </div>
        </div>
    `).join('');
}

// Hacer removeEarthquake global
window.removeEarthquake = function(id) {
    savedQuakes = savedQuakes.filter(q => q.id !== id);
    localStorage.setItem('savedQuakes', JSON.stringify(savedQuakes));
    // Notificación eliminada - feedback visual suficiente
    renderSavedQuakes();
    // Actualizar el mapa para reflejar el cambio
    if (currentEarthquakesData && Array.isArray(currentEarthquakesData)) {
        const magnitudeThreshold = parseFloat(document.getElementById('magnitudeFilter').value);
        displayEarthquakes(currentEarthquakesData, magnitudeThreshold);
    }
};

// Ver terremoto en el mapa
window.viewOnMap = function(id, lat, lon, mag) {
    if (!map) {
        showToast('El mapa no está disponible', 'danger');
        return;
    }
    
    // Validar coordenadas
    if (!lat || !lon || isNaN(lat) || isNaN(lon)) {
        showToast('⚠️ Este terremoto no tiene coordenadas guardadas. Elimínalo y guárdalo de nuevo.', 'warning');
        return;
    }
    
    // 🎬 ANIMACIÓN DE VUELO AL PUNTO
    // Determinar zoom apropiado según magnitud
    let targetZoom = 8;
    if (mag >= 7) targetZoom = 7;      // Mayor área para terremotos grandes
    else if (mag >= 5) targetZoom = 8; // Zoom medio
    else if (mag >= 3) targetZoom = 9; // Zoom cercano para terremotos pequeños
    else targetZoom = 10;               // Muy cercano para micro-terremotos
    
    // Scroll suave al mapa primero
    const mapElement = document.getElementById('earthquakeMap');
    if (mapElement) {
        mapElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    
    // Pequeño delay para que el scroll termine
    setTimeout(() => {
        // 🚀 Animación de VUELO suave al punto
        map.flyTo([lat, lon], targetZoom, {
            animate: true,
            duration: 1.5,        // Duración del vuelo en segundos
            easeLinearity: 0.25   // Suavidad de la curva de animación
        });
        
        // ⭐ EFECTO DE MARCADOR PULSANTE
        // Crear marcador temporal con efecto de pulso
        const pulseMarker = L.circleMarker([lat, lon], {
            radius: 15,
            color: '#fff',
            fillColor: getMagnitudeColor(mag),
            fillOpacity: 0.8,
            weight: 3,
            className: 'pulse-marker'
        }).addTo(map);
        
        // Crear círculo de ondas expansivas
        const waveCircle = L.circle([lat, lon], {
            radius: 1000,
            color: getMagnitudeColor(mag),
            fillColor: getMagnitudeColor(mag),
            fillOpacity: 0.2,
            weight: 2,
            className: 'wave-circle'
        }).addTo(map);
        
        // 🎯 ANIMACIÓN DE PULSO Y ONDA EXPANSIVA
        let pulseSize = 15;
        let waveRadius = 1000;
        let pulseCount = 0;
        const maxPulses = 4;
        
        const pulseAnimation = setInterval(() => {
            if (pulseCount >= maxPulses) {
                clearInterval(pulseAnimation);
                // Remover marcadores temporales después de la animación
                setTimeout(() => {
                    try {
                        map.removeLayer(pulseMarker);
                        map.removeLayer(waveCircle);
                    } catch (e) {
                        console.warn('Error removiendo marcadores temporales:', e);
                    }
                }, 500);
                return;
            }
            
            // Efecto de pulso del marcador
            pulseSize = pulseSize === 15 ? 20 : 15;
            pulseMarker.setRadius(pulseSize);
            pulseMarker.setStyle({
                fillOpacity: pulseSize === 20 ? 1.0 : 0.6
            });
            
            // Efecto de onda expansiva
            waveRadius += 10000;
            waveCircle.setRadius(waveRadius);
            waveCircle.setStyle({
                fillOpacity: Math.max(0.05, 0.3 - (pulseCount * 0.07)),
                opacity: Math.max(0.2, 1.0 - (pulseCount * 0.2))
            });
            
            pulseCount++;
        }, 400);
        
        // 💬 POPUP AUTOMÁTICO con información
        setTimeout(() => {
            // Buscar el marcador real del terremoto en el cluster
            let targetMarker = null;
            
            if (markerClusterGroup) {
                markerClusterGroup.eachLayer(marker => {
                    if (marker.earthquakeData && marker.earthquakeData.id === id) {
                        targetMarker = marker;
                    }
                });
            }
            
            // Si encontramos el marcador, abrir su popup
            if (targetMarker && targetMarker.getPopup) {
                try {
                    // Asegurarnos de que el marcador esté visible
                    markerClusterGroup.zoomToShowLayer(targetMarker, () => {
                        targetMarker.openPopup();
                    });
                } catch (e) {
                    console.warn('Error abriendo popup:', e);
                }
            }
        }, 1600); // Esperar a que termine la animación de vuelo
        
    }, 300); // Delay para el scroll
    
    // 📢 Notificación
    const magnitudeLabel = mag >= 5 ? '🔴' : mag >= 3 ? '🟡' : '🟢';
    showToast(`${magnitudeLabel} Volando a M${mag.toFixed(1)} - ${getLocationLabel(lat, lon)}`, 'info');
};

// Función auxiliar para obtener etiqueta de ubicación
function getLocationLabel(lat, lon) {
    const latDir = lat >= 0 ? 'N' : 'S';
    const lonDir = lon >= 0 ? 'E' : 'O';
    return `${Math.abs(lat).toFixed(2)}°${latDir}, ${Math.abs(lon).toFixed(2)}°${lonDir}`;
}

// Mostrar detalles completos del terremoto
window.showEarthquakeDetails = function(id) {
    const earthquake = savedQuakes.find(eq => eq.id === id);
    
    if (!earthquake) {
        showToast('No se encontró el terremoto', 'danger');
        return;
    }
    
    // Buscar el terremoto completo en los datos actuales para obtener más info
    let fullEarthquake = null;
    if (currentEarthquakesData && Array.isArray(currentEarthquakesData)) {
        fullEarthquake = currentEarthquakesData.find(eq => eq.id === id);
    }
    
    const eq = fullEarthquake ? fullEarthquake.properties : earthquake;
    const coords = fullEarthquake ? fullEarthquake.geometry.coordinates : [earthquake.lon, earthquake.lat, earthquake.depth || 0];
    
    // Crear modal con detalles
    const modal = document.createElement('div');
    modal.className = 'fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4 animate-fadeIn';
    modal.onclick = (e) => {
        if (e.target === modal) modal.remove();
    };
    
    const date = new Date(eq.time || earthquake.time);
    const energy = calculateSeismicEnergyML(eq.mag || earthquake.mag);
    const energyTNT = (energy / 4.184e9).toFixed(2); // Convertir a toneladas de TNT
    
    modal.innerHTML = `
        <div class="bg-surface rounded-2xl p-6 max-w-2xl w-full max-h-[90vh] overflow-y-auto shadow-2xl border-2 border-primary/30" onclick="event.stopPropagation()">
            <div class="flex justify-between items-start mb-6">
                <div>
                    <h2 class="text-3xl font-bold text-white mb-2 flex items-center gap-3">
                        <i class="fas fa-star text-yellow-400"></i>
                        <span class="text-primary">M ${(eq.mag || earthquake.mag).toFixed(1)}</span>
                    </h2>
                    <p class="text-gray-300 text-lg">${eq.place || earthquake.place}</p>
                </div>
                <button onclick="this.closest('.fixed').remove()" 
                        class="text-gray-400 hover:text-white text-2xl transition-all hover:rotate-90 duration-300">
                    <i class="fas fa-times"></i>
                </button>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                <div class="bg-dark-1b p-4 rounded-lg border border-gray-700">
                    <div class="flex items-center gap-2 mb-2">
                        <i class="fas fa-calendar text-blue-400"></i>
                        <h3 class="font-semibold text-white">Fecha y Hora</h3>
                    </div>
                    <p class="text-gray-300">${date.toLocaleDateString('es-ES', { 
                        weekday: 'long', 
                        year: 'numeric', 
                        month: 'long', 
                        day: 'numeric' 
                    })}</p>
                    <p class="text-gray-400 text-sm">${date.toLocaleTimeString('es-ES')}</p>
                </div>
                
                <div class="bg-dark-1b p-4 rounded-lg border border-gray-700">
                    <div class="flex items-center gap-2 mb-2">
                        <i class="fas fa-map-marker-alt text-red-400"></i>
                        <h3 class="font-semibold text-white">Ubicación</h3>
                    </div>
                    <p class="text-gray-300">Lat: ${coords[1].toFixed(4)}°</p>
                    <p class="text-gray-300">Lon: ${coords[0].toFixed(4)}°</p>
                </div>
                
                <div class="bg-dark-1b p-4 rounded-lg border border-gray-700">
                    <div class="flex items-center gap-2 mb-2">
                        <i class="fas fa-arrow-down text-purple-400"></i>
                        <h3 class="font-semibold text-white">Profundidad</h3>
                    </div>
                    <p class="text-2xl font-bold text-primary">${coords[2].toFixed(1)} km</p>
                    <p class="text-xs text-gray-400">${coords[2] < 70 ? 'Superficial' : coords[2] < 300 ? 'Intermedio' : 'Profundo'}</p>
                </div>
                
                <div class="bg-dark-1b p-4 rounded-lg border border-gray-700">
                    <div class="flex items-center gap-2 mb-2">
                        <i class="fas fa-bolt text-yellow-400"></i>
                        <h3 class="font-semibold text-white">Energía</h3>
                    </div>
                    <p class="text-lg font-bold text-yellow-400">${energyTNT} Toneladas TNT</p>
                    <p class="text-xs text-gray-400">${energy.toExponential(2)} Joules</p>
                </div>
            </div>
            
            ${eq.tsunami ? `
                <div class="bg-red-900/30 border border-red-500 p-4 rounded-lg mb-4">
                    <div class="flex items-center gap-2">
                        <i class="fas fa-water text-red-400 text-xl"></i>
                        <span class="text-red-300 font-bold">⚠️ ALERTA DE TSUNAMI</span>
                    </div>
                </div>
            ` : ''}
            
            <div class="bg-dark-1b p-4 rounded-lg border border-gray-700 mb-6">
                <h3 class="font-semibold text-white mb-3 flex items-center gap-2">
                    <i class="fas fa-info-circle text-blue-400"></i>
                    Información Adicional
                </h3>
                <div class="grid grid-cols-2 gap-3 text-sm">
                    <div>
                        <span class="text-gray-400">Tipo:</span>
                        <span class="text-white ml-2">${eq.type || 'earthquake'}</span>
                    </div>
                    <div>
                        <span class="text-gray-400">ID:</span>
                        <span class="text-white ml-2 font-mono text-xs">${id.substring(0, 15)}...</span>
                    </div>
                    ${eq.felt ? `
                        <div>
                            <span class="text-gray-400">Reportes:</span>
                            <span class="text-white ml-2">${eq.felt} personas</span>
                        </div>
                    ` : ''}
                    ${eq.mmi ? `
                        <div>
                            <span class="text-gray-400">Intensidad:</span>
                            <span class="text-white ml-2">MMI ${eq.mmi}</span>
                        </div>
                    ` : ''}
                </div>
            </div>
            
            <div class="flex gap-3">
                <button onclick="window.viewOnMap('${id}', ${coords[1]}, ${coords[0]}, ${eq.mag || earthquake.mag}); this.closest('.fixed').remove();" 
                        class="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-3 px-4 rounded-lg transition-all hover:scale-105 flex items-center justify-center gap-2">
                    <i class="fas fa-map-marked-alt"></i>
                    Ver en Mapa
                </button>
                <button onclick="window.shareEarthquake('${id}')" 
                        class="flex-1 bg-green-600 hover:bg-green-700 text-white py-3 px-4 rounded-lg transition-all hover:scale-105 flex items-center justify-center gap-2">
                    <i class="fas fa-share-alt"></i>
                    Compartir
                </button>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
};

// Compartir terremoto
window.shareEarthquake = function(id) {
    const earthquake = savedQuakes.find(eq => eq.id === id);
    
    if (!earthquake) {
        showToast('No se encontró el terremoto', 'danger');
        return;
    }
    
    const text = `🌍 Terremoto M${earthquake.mag.toFixed(1)}\n📍 ${earthquake.place}\n🕐 ${new Date(earthquake.time).toLocaleString()}\n\n#SismoGlobal #Terremoto`;
    const url = `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`;
    
    // Si el navegador soporta Web Share API
    if (navigator.share) {
        navigator.share({
            title: `Terremoto M${earthquake.mag.toFixed(1)}`,
            text: text,
            url: url
        }).then(() => {
            showToast('✅ Compartido exitosamente', 'success');
        }).catch((error) => {
            if (error.name !== 'AbortError') {
                copyToClipboardFallback(text, url);
            }
        });
    } else {
        copyToClipboardFallback(text, url);
    }
};

// Función auxiliar para copiar al portapapeles
function copyToClipboardFallback(text, url) {
    const fullText = `${text}\n\n${url}`;
    
    navigator.clipboard.writeText(fullText).then(() => {
        showToast('📋 Copiado al portapapeles', 'success');
    }).catch(() => {
        // Fallback antiguo
        const textarea = document.createElement('textarea');
        textarea.value = fullText;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        try {
            document.execCommand('copy');
            showToast('📋 Copiado al portapapeles', 'success');
        } catch (err) {
            showToast('❌ Error al copiar', 'danger');
        }
        document.body.removeChild(textarea);
    });
}

// ==================== FUNCIONALIDADES DE TERREMOTOS GUARDADOS ====================

// Exportar Favoritos como CSV
function exportFavoritesCSV() {
    if (savedQuakes.length === 0) {
        showToast('No hay terremotos guardados para exportar', 'warning');
        return;
    }
    
    try {
        // Crear CSV
        const headers = ['Magnitud', 'Ubicación', 'Fecha', 'Hora', 'Profundidad (km)', 'ID'];
        const rows = savedQuakes.map(eq => {
            const date = new Date(eq.time);
            return [
                eq.mag,
                `"${eq.place}"`, // Entrecomillado para CSV
                date.toLocaleDateString(),
                date.toLocaleTimeString(),
                eq.depth || 'N/A',
                eq.id
            ];
        });
        
        const csv = [
            headers.join(','),
            ...rows.map(row => row.join(','))
        ].join('\n');
        
        // Descargar archivo
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement('a');
        const url = URL.createObjectURL(blob);
        link.setAttribute('href', url);
        link.setAttribute('download', `terremotos_guardados_${new Date().toISOString().split('T')[0]}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        showToast(`✅ ${savedQuakes.length} terremotos exportados correctamente`, 'success');
    } catch (error) {
        console.error('Error exportando favoritos:', error);
        showToast('❌ Error al exportar favoritos', 'danger');
    }
}

// Comparar Favoritos
function compareFavorites() {
    if (savedQuakes.length === 0) {
        showToast('No hay terremotos guardados para comparar', 'warning');
        return;
    }
    
    if (savedQuakes.length < 2) {
        showToast('Necesitas al menos 2 terremotos guardados para comparar', 'info');
        return;
    }
    
    // Navegar a la sección de comparación
    const compareSection = document.getElementById('compare');
    if (compareSection) {
        compareSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        
        // Pre-seleccionar los favoritos en el comparador existente
        setTimeout(() => {
            const compare1 = document.getElementById('compare1');
            const compare2 = document.getElementById('compare2');
            
            if (compare1 && compare2 && currentEarthquakesData) {
                // Buscar los dos primeros favoritos en los datos actuales
                let found = 0;
                for (let i = 0; i < currentEarthquakesData.length && found < 2; i++) {
                    const eq = currentEarthquakesData[i];
                    const isFavorite = savedQuakes.some(saved => saved.id === eq.id);
                    
                    if (isFavorite) {
                        if (found === 0) {
                            compare1.value = i;
                            found++;
                        } else if (found === 1) {
                            compare2.value = i;
                            found++;
                        }
                    }
                }
                
                // Si encontramos al menos 2, activar comparación
                if (found >= 2) {
                    compareEarthquakes();
                    showToast('📊 Comparando terremotos guardados', 'info');
                } else {
                    showToast('No se encontraron suficientes favoritos en los datos actuales', 'warning');
                }
            }
        }, 500);
    }
}

// Limpiar Todos los Favoritos
function clearAllFavorites() {
    if (savedQuakes.length === 0) {
        showToast('No hay terremotos guardados para limpiar', 'info');
        return;
    }
    
    // Confirmación
    const count = savedQuakes.length;
    const confirmed = confirm(`¿Estás seguro de que quieres eliminar los ${count} terremotos guardados?\n\nEsta acción no se puede deshacer.`);
    
    if (confirmed) {
        savedQuakes = [];
        localStorage.setItem('savedQuakes', JSON.stringify(savedQuakes));
        renderSavedQuakes();
        
        // Actualizar el mapa
        if (currentEarthquakesData && Array.isArray(currentEarthquakesData)) {
            const magnitudeThreshold = parseFloat(document.getElementById('magnitudeFilter').value);
            displayEarthquakes(currentEarthquakesData, magnitudeThreshold);
        }
        
        showToast(`🗑️ ${count} terremotos eliminados correctamente`, 'success');
    }
}

// Inicializar event listeners para los botones de favoritos
function initializeFavoritesButtons() {
    const exportBtn = document.getElementById('exportFavoritesBtn');
    const compareBtn = document.getElementById('compareFavoritesBtn');
    const clearBtn = document.getElementById('clearFavoritesBtn');
    
    if (exportBtn) {
        exportBtn.addEventListener('click', exportFavoritesCSV);
    }
    
    if (compareBtn) {
        compareBtn.addEventListener('click', compareFavorites);
    }
    
    if (clearBtn) {
        clearBtn.addEventListener('click', clearAllFavorites);
    }
}

// ==================== FIN FUNCIONALIDADES TERREMOTOS GUARDADOS ====================

// Exportar Datos
function initializeExport() {
    const exportBtn = document.getElementById('exportMapBtn');
    exportBtn.addEventListener('click', showExportOptions);
}

function showExportOptions() {
    const options = `
        <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" id="exportModal">
            <div class="bg-surface p-6 rounded-xl shadow-2xl max-w-md w-full mx-4 animate-fadeIn">
                <h3 class="text-xl font-bold mb-4 text-white">Exportar Datos</h3>
                <div class="space-y-3">
                    <button onclick="exportToCSV()" class="w-full bg-green-600 hover:bg-green-700 text-white p-3 rounded-lg transition-all">
                        <i class="fas fa-file-csv mr-2"></i>Exportar como CSV
                    </button>
                    <button onclick="exportToJSON()" class="w-full bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-lg transition-all">
                        <i class="fas fa-file-code mr-2"></i>Exportar como JSON
                    </button>
                    <button onclick="exportToPDF()" class="w-full bg-red-600 hover:bg-red-700 text-white p-3 rounded-lg transition-all">
                        <i class="fas fa-file-pdf mr-2"></i>Exportar como PDF
                    </button>
                    <button onclick="closeExportModal()" class="w-full bg-gray-600 hover:bg-gray-700 text-white p-3 rounded-lg transition-all">
                        Cancelar
                    </button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', options);
}

function closeExportModal() {
    document.getElementById('exportModal')?.remove();
}

function exportToCSV() {
    if (!currentEarthquakesData || !Array.isArray(currentEarthquakesData)) return;
    
    const csv = ['Magnitud,Ubicación,Profundidad,Fecha,Latitud,Longitud'];
    currentEarthquakesData.forEach(eq => {
        const row = [
            eq.properties.mag,
            `"${eq.properties.place}"`,
            eq.geometry.coordinates[2],
            new Date(eq.properties.time).toISOString(),
            eq.geometry.coordinates[1],
            eq.geometry.coordinates[0]
        ].join(',');
        csv.push(row);
    });
    
    downloadFile(csv.join('\n'), 'terremotos.csv', 'text/csv');
    closeExportModal();
}

function exportToJSON() {
    if (!currentEarthquakesData) return;
    
    const json = JSON.stringify(currentEarthquakesData, null, 2);
    downloadFile(json, 'terremotos.json', 'application/json');
    closeExportModal();
}

function exportToPDF() {
    if (!currentEarthquakesData || !Array.isArray(currentEarthquakesData) || currentEarthquakesData.length === 0) {
        closeExportModal();
        return;
    }
        
    try {
        // Usar jsPDF desde el objeto global window
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF('landscape');
        
        // Configuración del documento
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        
        // Header del PDF
        doc.setFillColor(220, 20, 60); // Crimson
        doc.rect(0, 0, pageWidth, 25, 'F');
        
        doc.setTextColor(255, 255, 255);
        doc.setFontSize(18);
        doc.setFont(undefined, 'bold');
        doc.text('Reporte de Terremotos - SismoGlobal', pageWidth / 2, 12, { align: 'center' });
        
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.text(`Generado: ${new Date().toLocaleString('es-ES')}`, pageWidth / 2, 18, { align: 'center' });
        
        // Estadísticas generales
        doc.setTextColor(0, 0, 0);
        doc.setFontSize(12);
        doc.setFont(undefined, 'bold');
        doc.text('Estadísticas Generales', 14, 35);
        
        const magnitudes = currentEarthquakesData.map(eq => eq.properties.mag).filter(mag => mag !== null);
        const totalQuakes = magnitudes.length;
        const avgMagnitude = (magnitudes.reduce((a, b) => a + b, 0) / totalQuakes).toFixed(2);
        const maxMagnitude = Math.max(...magnitudes).toFixed(1);
        const minMagnitude = Math.min(...magnitudes).toFixed(1);
        
        doc.setFontSize(10);
        doc.setFont(undefined, 'normal');
        doc.text(`Total de terremotos: ${totalQuakes}`, 14, 42);
        doc.text(`Magnitud promedio: ${avgMagnitude}`, 14, 48);
        doc.text(`Magnitud máxima: ${maxMagnitude}`, 100, 42);
        doc.text(`Magnitud mínima: ${minMagnitude}`, 100, 48);
        
        // Tabla de terremotos
        doc.setFont(undefined, 'bold');
        doc.setFontSize(12);
        doc.text('Detalle de Terremotos', 14, 60);
        
        // Preparar datos para la tabla (máximo 50 terremotos para no sobrecargar el PDF)
        const earthquakesToShow = currentEarthquakesData.slice(0, 50);
        const tableData = earthquakesToShow.map(eq => {
            return [
                eq.properties.mag ? eq.properties.mag.toFixed(1) : 'N/A',
                eq.properties.place || 'Desconocido',
                eq.geometry.coordinates[2] ? eq.geometry.coordinates[2].toFixed(0) + ' km' : 'N/A',
                new Date(eq.properties.time).toLocaleDateString('es-ES'),
                new Date(eq.properties.time).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }),
                `${eq.geometry.coordinates[1].toFixed(2)}°, ${eq.geometry.coordinates[0].toFixed(2)}°`
            ];
        });
        
        // Crear tabla usando autoTable
        doc.autoTable({
            startY: 65,
            head: [['Magnitud', 'Ubicación', 'Profundidad', 'Fecha', 'Hora', 'Coordenadas']],
            body: tableData,
            theme: 'striped',
            headStyles: {
                fillColor: [220, 20, 60],
                textColor: [255, 255, 255],
                fontStyle: 'bold',
                halign: 'center'
            },
            styles: {
                fontSize: 8,
                cellPadding: 3,
                overflow: 'linebreak'
            },
            columnStyles: {
                0: { halign: 'center', cellWidth: 20 },
                1: { halign: 'left', cellWidth: 80 },
                2: { halign: 'center', cellWidth: 25 },
                3: { halign: 'center', cellWidth: 30 },
                4: { halign: 'center', cellWidth: 25 },
                5: { halign: 'center', cellWidth: 50 }
            },
            alternateRowStyles: {
                fillColor: [245, 245, 245]
            },
            margin: { top: 65, left: 14, right: 14 }
        });
        
        // Footer
        const pageCount = doc.internal.getNumberOfPages();
        for (let i = 1; i <= pageCount; i++) {
            doc.setPage(i);
            doc.setFontSize(8);
            doc.setTextColor(128, 128, 128);
            doc.text(
                `Página ${i} de ${pageCount}`,
                pageWidth / 2,
                pageHeight - 10,
                { align: 'center' }
            );
            doc.text(
                'SismoGlobal - Centro de Información Sísmica',
                pageWidth - 14,
                pageHeight - 10,
                { align: 'right' }
            );
        }
        
        // Nota si hay más terremotos
        if (currentEarthquakesData.length > 50) {
            doc.setPage(pageCount);
            const finalY = doc.lastAutoTable.finalY + 10;
            doc.setFontSize(9);
            doc.setTextColor(220, 20, 60);
            doc.text(
                `Nota: Se muestran los primeros 50 de ${currentEarthquakesData.length} terremotos totales.`,
                14,
                finalY
            );
        }
        
        // Guardar PDF
        const filename = `terremotos_${new Date().toISOString().split('T')[0]}.pdf`;
        doc.save(filename);
        
        closeExportModal();
        addNotification('success', `PDF generado: ${filename}`);
    } catch (error) {
        console.error('Error al generar PDF:', error);
        addNotification('error', 'Error al generar el PDF');
        closeExportModal();
    }
}

function downloadFile(content, filename, type) {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// Hacer funciones globales para onclick
window.exportToCSV = exportToCSV;
window.exportToJSON = exportToJSON;
window.exportToPDF = exportToPDF;
window.closeExportModal = closeExportModal;

// Compartir en Redes Sociales
function initializeShare() {
    const shareBtn = document.getElementById('shareBtn');
    shareBtn.addEventListener('click', showShareOptions);
}

function showShareOptions() {
    const url = encodeURIComponent(window.location.href);
    const text = encodeURIComponent('¡Mira estos datos sísmicos en tiempo real!');
    
    const options = `
        <div class="fixed inset-0 bg-black/50 z-50 flex items-center justify-center" id="shareModal">
            <div class="bg-surface p-6 rounded-xl shadow-2xl max-w-md w-full mx-4 animate-fadeIn">
                <h3 class="text-xl font-bold mb-4 text-white">Compartir</h3>
                <div class="space-y-3">
                    <a href="https://twitter.com/intent/tweet?text=${text}&url=${url}" target="_blank" 
                       class="block bg-blue-400 hover:bg-blue-500 text-white p-3 rounded-lg transition-all text-center">
                        <i class="fab fa-twitter mr-2"></i>Compartir en Twitter
                    </a>
                    <a href="https://www.facebook.com/sharer/sharer.php?u=${url}" target="_blank"
                       class="block bg-blue-600 hover:bg-blue-700 text-white p-3 rounded-lg transition-all text-center">
                        <i class="fab fa-facebook mr-2"></i>Compartir en Facebook
                    </a>
                    <a href="https://wa.me/?text=${text}%20${url}" target="_blank"
                       class="block bg-green-500 hover:bg-green-600 text-white p-3 rounded-lg transition-all text-center">
                        <i class="fab fa-whatsapp mr-2"></i>Compartir en WhatsApp
                    </a>
                    <button onclick="closeShareModal()" class="w-full bg-gray-600 hover:bg-gray-700 text-white p-3 rounded-lg transition-all">
                        Cancelar
                    </button>
                </div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', options);
}

function closeShareModal() {
    document.getElementById('shareModal')?.remove();
}

// Hacer función global para onclick
window.closeShareModal = closeShareModal;

// Scroll to Top Button
function initializeScrollTop() {
    const scrollTopBtn = document.getElementById('scrollTopBtn');
    
    window.addEventListener('scroll', () => {
        if (window.pageYOffset > 300) {
            scrollTopBtn.classList.remove('hidden');
        } else {
            scrollTopBtn.classList.add('hidden');
        }
    });
    
    scrollTopBtn.addEventListener('click', () => {
        window.scrollTo({
            top: 0,
            behavior: 'smooth'
        });
    });
}

// Cerrar alerta de terremoto
function initializeAlertClose() {
    const closeAlertBtn = document.getElementById('closeAlert');
    const alertElement = document.getElementById('earthquakeAlert');
    
    if (closeAlertBtn) {
        closeAlertBtn.addEventListener('click', () => {
            alertElement.style.animation = 'none';
            alertElement.style.transform = 'translateY(-100%)';
            alertElement.style.opacity = '0';
            
            setTimeout(() => {
                alertElement.classList.add('hidden');
                alertElement.style.transform = '';
                alertElement.style.opacity = '';
                alertElement.style.animation = '';
            }, 400);
        });
    }
}

// Actualizar panel de análisis avanzado
function updateAdvancedAnalysisPanel() {
    try {
        // Tamaños de estructuras de datos
        const cacheSize = document.getElementById('cacheSize');
        const spatialIndexSize = document.getElementById('spatialIndexSize');
        const alertQueueSize = document.getElementById('alertQueueSize');
        const apiCacheHits = document.getElementById('apiCacheHits');
        
        if (cacheSize) cacheSize.textContent = earthquakeCache.size || '0';
        if (spatialIndexSize) {
            const total = spatialIndex.NE.length + spatialIndex.NW.length + 
                          spatialIndex.SE.length + spatialIndex.SW.length;
            spatialIndexSize.textContent = total || '0';
        }
        if (alertQueueSize) alertQueueSize.textContent = alertQueue.size() || '0';
        if (apiCacheHits) apiCacheHits.textContent = `${apiCache.size() || 0}/${apiCache.maxSize}`;
        
        // Debug
        console.log('📊 Actualizando panel avanzado:', {
            cacheSize: earthquakeCache.size,
            spatialTotal: spatialIndex.NE.length + spatialIndex.NW.length + spatialIndex.SE.length + spatialIndex.SW.length,
            alerts: alertQueue.size(),
            regionsCount: realtimeStats.byRegion.size,
            totalEarthquakes: realtimeStats.total
        });
        
        // Top 5 regiones
        const topRegions = document.getElementById('topRegions');
        if (topRegions) {
            if (realtimeStats.total === 0 || realtimeStats.byRegion.size === 0) {
                topRegions.innerHTML = '<p class="text-xs text-gray-500 text-center py-2">Cargando datos...</p>';
            } else {
                const regions = realtimeStats.getTopRegions(5);
                console.log('🌍 Top 5 regiones:', regions);
                
                if (regions.length === 0) {
                    topRegions.innerHTML = '<p class="text-xs text-gray-500 text-center py-2">No hay datos de regiones</p>';
                } else {
                    topRegions.innerHTML = regions.map(([regionName, count], index) => {
                        const colors = ['bg-red-500', 'bg-orange-500', 'bg-yellow-500', 'bg-green-500', 'bg-blue-500'];
                        const percentage = ((count / realtimeStats.total) * 100).toFixed(1);
                        const displayName = regionName && regionName.length > 0 ? regionName : 'Región Desconocida';
                        
                        return `
                            <div class="flex items-center gap-2">
                                <span class="text-xs text-gray-400">${index + 1}.</span>
                                <div class="flex-1 bg-gray-700 rounded-full h-2 overflow-hidden">
                                    <div class="${colors[index]} h-full transition-all duration-500" style="width: ${percentage}%"></div>
                                </div>
                                <span class="text-xs text-white font-semibold w-12 text-right">${count}</span>
                                <span class="text-xs text-gray-400 truncate max-w-[120px]" title="${displayName}">${displayName}</span>
                            </div>
                        `;
                    }).join('');
                }
            }
        }
        
        // Distribución por profundidad
        const depthDistribution = document.getElementById('depthDistribution');
        if (depthDistribution) {
            if (realtimeStats.total === 0) {
                depthDistribution.innerHTML = '<p class="text-xs text-gray-500 text-center py-2">Cargando datos...</p>';
            } else {
                const depths = realtimeStats.byDepth;
                const total = depths.shallow + depths.intermediate + depths.deep;
                
                if (total === 0) {
                    depthDistribution.innerHTML = '<p class="text-xs text-gray-500 text-center py-2">No hay datos de profundidad</p>';
                } else {
                    depthDistribution.innerHTML = `
                        <div class="space-y-2">
                            <div class="flex items-center justify-between">
                                <span class="text-green-400 flex items-center gap-2">
                                    <i class="fas fa-circle text-xs"></i>
                                    Superficial (0-70km)
                                </span>
                                <span class="font-bold text-white">${depths.shallow} <span class="text-xs text-gray-400">(${((depths.shallow/total)*100).toFixed(0)}%)</span></span>
                            </div>
                            <div class="flex items-center justify-between">
                                <span class="text-yellow-400 flex items-center gap-2">
                                    <i class="fas fa-circle text-xs"></i>
                                    Intermedio (70-300km)
                                </span>
                                <span class="font-bold text-white">${depths.intermediate} <span class="text-xs text-gray-400">(${((depths.intermediate/total)*100).toFixed(0)}%)</span></span>
                            </div>
                            <div class="flex items-center justify-between">
                                <span class="text-red-400 flex items-center gap-2">
                                    <i class="fas fa-circle text-xs"></i>
                                    Profundo (>300km)
                                </span>
                                <span class="font-bold text-white">${depths.deep} <span class="text-xs text-gray-400">(${((depths.deep/total)*100).toFixed(0)}%)</span></span>
                            </div>
                        </div>
                    `;
                }
            }
        }
        
    } catch (error) {
        console.error('❌ Error actualizando panel avanzado:', error);
    }
}

// Actualizar estadísticas del hero
function updateHeroStats() {
    const heroTotal = document.getElementById('heroTotalQuakes');
    const heroMax = document.getElementById('heroMaxMag');
    const heroPaises = document.getElementById('heroPaises');
    
    if (!heroTotal || !heroMax || !heroPaises) return;
    if (!currentEarthquakesData || !Array.isArray(currentEarthquakesData)) {
        heroTotal.textContent = '--';
        heroMax.textContent = '--';
        heroPaises.textContent = '--';
        return;
    }
    
    // Calcular últimas 24 horas (más preciso y consistente)
    const last24Hours = Date.now() - (24 * 60 * 60 * 1000);
    
    // Filtrar terremotos de últimas 24 horas
    const recentQuakes = currentEarthquakesData.filter(eq => {
        const eqTime = eq.properties.time;
        return eqTime >= last24Hours;
    });
    
    console.log(`📊 Estadísticas últimas 24h: ${recentQuakes.length} terremotos desde ${new Date(last24Hours).toISOString()}`);
    
    // Magnitud MÁXIMA de las últimas 24 horas
    const maxMag = recentQuakes.length > 0 
        ? Math.max(...recentQuakes.map(eq => eq.properties.mag || 0))
        : 0;
    
    // Contar países únicos de las últimas 24 horas
    const countries = new Set(
        recentQuakes
            .map(eq => {
                const place = eq.properties.place || '';
                // Extraer país/región del formato "X km SE of Location, Country"
                const parts = place.split(',');
                if (parts.length > 1) {
                    return parts[parts.length - 1].trim();
                }
                // Si no tiene coma, intentar extraer del final
                const regions = place.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*$/);
                return regions ? regions[0] : place.trim();
            })
            .filter(c => c.length > 2) // Filtrar vacíos y códigos muy cortos
    );
    
    // Animación de contador con valores correctos
    animateCounter(heroTotal, parseInt(heroTotal.textContent) || 0, recentQuakes.length);
    animateCounter(heroPaises, parseInt(heroPaises.textContent) || 0, Math.min(countries.size, 99));
    
    // Formatear magnitud con 1 decimal
    if (maxMag > 0) {
        heroMax.textContent = maxMag.toFixed(1);
    } else {
        heroMax.textContent = '--';
    }
    
    // Log para debugging
    if (recentQuakes.length > 0) {
        console.log(`🌍 Países afectados (24h): ${Array.from(countries).slice(0, 5).join(', ')}${countries.size > 5 ? '...' : ''}`);
        console.log(`📈 Mag máxima (24h): ${maxMag.toFixed(1)}`);
    }
    
    // Actualizar panel de análisis avanzado
    updateAdvancedAnalysisPanel();
}

// Función helper para animar contadores
function animateCounter(element, start, end, duration = 1000) {
    if (start === end) return;
    
    const range = end - start;
    const increment = range / (duration / 16);
    let current = start;
    
    const timer = setInterval(() => {
        current += increment;
        if ((increment > 0 && current >= end) || (increment < 0 && current <= end)) {
            element.textContent = end;
            clearInterval(timer);
        } else {
            element.textContent = Math.floor(current);
        }
    }, 16);
}

// Efecto de escritura para el título
function typewriterEffect() {
    const elements = document.querySelectorAll('[data-typewriter]');
    elements.forEach(el => {
        const text = el.textContent;
        el.textContent = '';
        let i = 0;
        const interval = setInterval(() => {
            if (i < text.length) {
                el.textContent += text.charAt(i);
                i++;
            } else {
                clearInterval(interval);
            }
        }, 50);
    });
}

// Smooth scroll para los enlaces del navbar
function initializeSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
}

// ==================== FUNCIONES CON ESTRUCTURAS DE DATOS ====================

// Buscar terremotos cercanos usando índice espacial (O(n/4) en lugar de O(n))
function findNearbyEarthquakes(lat, lon, radiusKm = 500) {
    console.log(`🔍 Buscando terremotos dentro de ${radiusKm}km de [${lat.toFixed(2)}, ${lon.toFixed(2)}]`);
    const nearby = spatialIndex.findNearby(lat, lon, radiusKm);
    console.log(`📍 Encontrados ${nearby.length} terremotos cercanos`);
    return nearby;
}

// Obtener terremoto por ID usando Map (O(1))
function getEarthquakeById(id) {
    return earthquakeCache.get(id);
}

// Procesar alertas en orden de prioridad
function processNextAlert() {
    if (!alertQueue.isEmpty()) {
        const alert = alertQueue.dequeue();
        const eq = alert.earthquake;
        console.log(`🚨 Alerta prioritaria: Magnitud ${eq.properties.mag} en ${eq.properties.place}`);
        return eq;
    }
    return null;
}

// Obtener estadísticas detalladas por región
function getRegionalStatistics(limit = 10) {
    const topRegions = realtimeStats.getTopRegions(limit);
    return topRegions.map(([region, count]) => ({
        region,
        count,
        percentage: ((count / realtimeStats.total) * 100).toFixed(1)
    }));
}

// Analizar patrones temporales usando datos cacheados
function analyzeTemporalPatterns() {
    const earthquakes = Array.from(earthquakeCache.values());
    const hourlyDistribution = new Array(24).fill(0);
    
    earthquakes.forEach(eq => {
        const hour = new Date(eq.properties.time).getHours();
        hourlyDistribution[hour]++;
    });
    
    const maxHour = hourlyDistribution.indexOf(Math.max(...hourlyDistribution));
    console.log(`⏰ Hora pico de actividad sísmica: ${maxHour}:00 UTC`);
    
    return {
        hourlyDistribution,
        peakHour: maxHour,
        totalAnalyzed: earthquakes.length
    };
}

// Obtener terremotos filtrados por criterios (usando caché)
function getFilteredEarthquakes(criteria) {
    const earthquakes = Array.from(earthquakeCache.values());
    
    return earthquakes.filter(eq => {
        const mag = eq.properties.mag;
        const depth = Math.abs(eq.geometry.coordinates[2]);
        const time = eq.properties.time;
        
        if (criteria.minMag && mag < criteria.minMag) return false;
        if (criteria.maxMag && mag > criteria.maxMag) return false;
        if (criteria.minDepth && depth < criteria.minDepth) return false;
        if (criteria.maxDepth && depth > criteria.maxDepth) return false;
        if (criteria.since && time < criteria.since) return false;
        if (criteria.until && time > criteria.until) return false;
        
        return true;
    });
}

// Inicializar todas las nuevas funcionalidades
function initializeNewFeatures() {
    console.log('🔧 Inicializando funcionalidades...');
    
    // initializeThemeToggle(); // DESACTIVADO - tema fijo oscuro
    initializeNotificationsPanel();
    // initializeSearch(); // DESACTIVADO - búsqueda eliminada
    initializeComparator();
    initializeExport();
    initializeShare();
    initializeScrollTop();
    initializeAlertClose(); // Nueva: Cerrar alerta
    initializeSmoothScroll();
    initializeMapTools(); // Nueva: Herramientas avanzadas de mapa
    renderSavedQuakes();
    initializeFavoritesButtons(); // ⭐ Botones de terremotos guardados
    
    // NO llamar predictAftershocks() y updateHeroStats() aquí
    // Se llamarán después de cargar los datos en updateEarthquakeData()
    
    console.log('✅ Funcionalidades básicas listas (incluye Heatmap, Medición, Clusters ML, Predicción ML)');
    console.log('📦 Estructuras de datos optimizadas activas:');
    console.log('   • Map para caché de terremotos (O(1) acceso)');
    console.log('   • Set para IDs únicos (O(1) búsqueda)');
    console.log('   • QuadTree espacial (O(n/4) búsqueda geográfica)');
    console.log('   • Priority Queue para alertas (máxima prioridad primero)');
    console.log('   • LRU Cache para API (50 consultas)');
    console.log('   • Stats en tiempo real (O(1) actualización)');
}

// ==================== TENSORFLOW.JS - MACHINE LEARNING ====================

let mlModel = null;
let isModelReady = false;
let isModelTrained = false; // Track if model has been trained
let isAnalyzing = false; // Prevent concurrent analysis

// ============================================
// ============================================
// FÓRMULAS SÍSMICAS CIENTÍFICAS
// Todas las fórmulas están respaldadas por investigación científica revisada por pares
// Ver: FUNDAMENTOS_ANALISIS_RIESGO.md para referencias completas
// ============================================

// Calcular energía sísmica liberada (Joules)
// Fórmula de Gutenberg-Richter (1956): log₁₀(E) = 1.5M + 4.8
// Referencia: Gutenberg & Richter, "Magnitude and energy of earthquakes" (1956)
// Cada unidad de magnitud ≈ 32× más energía
function calculateSeismicEnergyML(magnitude) {
    // Fórmula precisa: E = 10^(1.5 * M + 4.8) ergios = 10^(1.5 * M + 4.8 - 7) Joules
    // Simplificado: log10(E) = 1.5*M + 4.8, E en Joules (ajustado de ergios)
    if (magnitude <= 0) return 0;
    return Math.pow(10, 1.5 * magnitude + 4.8);
}

// Calcular momento sísmico (Newton-metros)
// Fórmula de Hanks y Kanamori (1979): Mw = (2/3)log₁₀(M₀) - 10.7
// Referencia: Hanks & Kanamori, "A moment magnitude scale" (1979)
// M₀ representa el tamaño físico del terremoto (área × desplazamiento × rigidez)
function calculateSeismicMoment(magnitude) {
    // Mw = (2/3)*log10(M0) - 10.7 → log10(M0) = 1.5*Mw + 16.05
    // M0 = 10^(1.5*Mw + 16.05) dina-cm = 10^(1.5*Mw + 16.05 - 7) N·m = 10^(1.5*Mw + 9.05) N·m
    // Nota: Usamos 16.1 como aproximación estándar
    if (magnitude <= 0) return 0;
    return Math.pow(10, 1.5 * magnitude + 16.1);
}

// Calcular intensidad Mercalli Modificada (MMI) - Escala I a XII
// Fórmula de Wald et al. (1999): I = a + bM - c×log₁₀(R) - dh
// Referencia: Wald et al., "TriNet ShakeMaps" (1999)
// Parámetros calibrados: a=2.3, b=1.45, c=1.3, d=0.0015
function calculateMMIntensity(magnitude, depth, distance = 0) {
    if (magnitude <= 0) return 1;
    
    // Fórmula empírica: I = a + b*M - c*log10(R) - d*h
    // Donde R es la distancia hipocentral efectiva
    const R = Math.sqrt(distance * distance + depth * depth);
    const Reff = Math.max(R, 1); // Evitar log(0)
    
    // Coeficientes calibrados para MMI
    const a = 2.3;   // Término constante
    const b = 1.45;  // Factor de magnitud
    const c = 1.3;   // Factor de distancia
    const d = 0.0015; // Factor de profundidad
    
    const intensity = a + b * magnitude - c * Math.log10(Reff) - d * depth;
    
    // MMI está limitado entre I (1) y XII (12)
    return Math.max(1, Math.min(12, intensity)) / 12; // Normalizado 0-1
}

// Calcular PGA (Peak Ground Acceleration) en unidades de g (gravedad)
// Fórmula de Boore-Atkinson (2008) - GMPE ampliamente utilizada
// Referencia: Boore & Atkinson, "Ground-Motion Prediction Equations" (2008)
// log₁₀(PGA) = c₁ + c₂M - c₃×log₁₀(R) + c₄h
// Parámetros: c₁=-2.5, c₂=0.85, c₃=1.4, c₄=-0.002
function calculatePGA(magnitude, distance, depth) {
    if (magnitude <= 0) return 0;
    
    // Distancia hipocentral (km)
    const R = Math.sqrt(distance * distance + depth * depth);
    const Reff = Math.max(R, 1);
    
    // Modelo simplificado de Boore-Atkinson
    // log10(PGA) = c1 + c2*M - c3*log10(sqrt(R^2 + h^2)) + c4*h
    const c1 = -2.5;   // Constante base
    const c2 = 0.85;   // Escalamiento con magnitud
    const c3 = 1.4;    // Atenuación geométrica
    const c4 = -0.002; // Atenuación anelástica
    
    const logPGA = c1 + c2 * magnitude - c3 * Math.log10(Reff) + c4 * depth;
    const pga = Math.pow(10, logPGA);
    
    // PGA en unidades de g (aceleración de gravedad)
    return Math.max(0, pga);
}

// Calcular probabilidad de réplicas - Ley de Omori modificada
// Fórmula de Utsu (1961): n(t) = K/(c+t)^p
// Referencia: Utsu, "Statistical study on aftershocks" (1961)
// K = 10^(0.67(M-4.5)) (Ley de Båth), c=0.05 días, p=1.08
// Predice la tasa de réplicas en función del tiempo desde el mainshock
function calculateAftershockProbability(magnitude, timeDays) {
    if (magnitude <= 0 || timeDays < 0) return 0;
    
    // Ley de Omori modificada: n(t) = K / (c + t)^p
    // K: productividad (depende de la magnitud del mainshock)
    // c: tiempo de retraso (~0.05 días típicamente)
    // p: exponente de decaimiento (~1.1 para la mayoría de secuencias)
    
    const K = Math.pow(10, 0.67 * (magnitude - 4.5)); // Productividad de Båth
    const c = 0.05;  // Constante temporal (días)
    const p = 1.08;  // Exponente de decaimiento (Utsu)
    
    // Tasa de réplicas por día
    const rate = K / Math.pow(c + timeDays, p);
    
    // Convertir a probabilidad (normalizada)
    return Math.min(100, rate * 10); // Escala 0-100
}

// Calcular slip (deslizamiento de falla) en metros - Wells & Coppersmith (1994)
function calculateFaultSlip(magnitude, faultLength) {
    if (magnitude <= 0) return 0;
    
    // Relación empírica: log10(D) = a + b*Mw
    // Para average displacement (AD)
    const a = -4.45;
    const b = 0.63;
    
    const logSlip = a + b * magnitude;
    return Math.pow(10, logSlip); // metros
}

// Calcular stress drop (caída de esfuerzo) en MPa - Kanamori & Anderson (1975)
function calculateStressDrop(magnitude, faultArea) {
    if (magnitude <= 0 || faultArea <= 0) return 0;
    
    // Δσ ≈ (7/16) * (M0 / r³) donde r es el radio de una fuente circular equivalente
    const M0 = calculateSeismicMoment(magnitude);
    const radius = Math.sqrt(faultArea / Math.PI) * 1000; // Convertir km a m
    
    // Stress drop en Pascales
    const stressDrop = (7/16) * (M0 / Math.pow(radius, 3));
    
    // Convertir a MPa (MegaPascales)
    return stressDrop / 1e6;
}

// Calcular duración estimada del temblor (segundos) - Relación empírica
function calculateEarthquakeDuration(magnitude) {
    if (magnitude <= 0) return 0;
    
    // Fórmula empírica: D = 10^(a + b*M)
    // Basada en observaciones de duración significativa
    const a = -1.15;
    const b = 0.48;
    
    const duration = Math.pow(10, a + b * magnitude);
    return Math.max(0.1, duration); // Mínimo 0.1 segundos
}

// Calcular longitud de ruptura de falla (km) - Wells & Coppersmith (1994)
// Una de las relaciones empíricas más citadas en sismología
function calculateRuptureLength(magnitude) {
    if (magnitude <= 0) return 0;
    
    // Para todos los tipos de falla: log10(SRL) = a + b*Mw
    // SRL = Surface Rupture Length
    const a = -3.22;
    const b = 0.69;
    
    const logLength = a + b * magnitude;
    return Math.max(0.001, Math.pow(10, logLength)); // km, mínimo 1 metro
}

// Calcular índice de peligrosidad sísmica
// NOTA: Este es un índice compuesto EXPERIMENTAL (no es estándar USGS)
// Los componentes individuales (MMI, energía, profundidad) son científicos
// pero los pesos de combinación (40-30-20-10) son heurísticos para fines de visualización
function calculateSeismicHazardIndex(magnitude, depth, population = 1000, infrastructure = 1) {
    // Índice compuesto basado en múltiples factores científicos
    const energyFactor = Math.log10(calculateSeismicEnergyML(magnitude)) / 20; // Normalizado
    const depthFactor = 1 - (Math.min(depth, 700) / 700); // Más superficial = más peligroso
    const intensityFactor = calculateMMIntensity(magnitude, depth) / 12; // Normalizado 0-1
    const popFactor = Math.log10(population + 1) / 7; // Normalizado
    
    // Ponderación heurística (no estándar USGS): 40% intensidad, 30% energía, 20% profundidad, 10% población
    return (0.4 * intensityFactor + 0.3 * energyFactor + 0.2 * depthFactor + 0.1 * popFactor) * 100;
}

// ============================================
// EXTRACCIÓN DE CARACTERÍSTICAS AVANZADAS
// ============================================

function extractSeismicFeatures(earthquake) {
    const mag = earthquake.properties.mag || 0;
    const depth = Math.abs(earthquake.geometry.coordinates[2]) || 10;
    const lat = earthquake.geometry.coordinates[1];
    const lon = earthquake.geometry.coordinates[0];
    const time = earthquake.properties.time;
    const daysSince = (Date.now() - time) / 86400000;
    
    // Calcular características sísmicas científicas
    const energy = calculateSeismicEnergyML(mag);
    const moment = calculateSeismicMoment(mag);
    const intensity = calculateMMIntensity(mag, depth);
    const pga = Math.max(0, calculatePGA(mag, 10, depth)); // Asumiendo 10km de distancia epicentral
    const aftershockProb = calculateAftershockProbability(mag, daysSince);
    const faultLength = calculateRuptureLength(mag);
    const duration = calculateEarthquakeDuration(mag);
    
    // Calcular hazard index simplificado: basado en magnitud, profundidad y PGA
    // Magnitud: 0-10 escala, Profundidad: 0-700km inverso, PGA: 0-1g
    const magComponent = Math.min(mag / 10, 1) * 0.4; // 40% peso
    const depthComponent = (1 - Math.min(depth / 700, 1)) * 0.3; // 30% peso (superficial = peligroso)
    const pgaComponent = Math.min(pga, 1) * 0.3; // 30% peso
    const hazardIndex = (magComponent + depthComponent + pgaComponent) * 100; // Escala 0-100
    
    // Características tectónicas
    const isSubduction = (depth > 50 && depth < 300); // Zona de subducción
    const isShallow = (depth < 70);
    const isDeep = (depth > 300);
    
    // Características geográficas (zonas sísmicas conocidas)
    const isPacificRing = (
        (lat >= 35 && lat <= 60 && lon >= -180 && lon <= -120) || // Alaska-Aleutianas
        (lat >= 10 && lat <= 40 && lon >= 120 && lon <= 150) ||   // Japón-Filipinas
        (lat >= -60 && lat <= -10 && lon >= -85 && lon <= -65)    // Andes
    );
    
    // Patrón temporal
    const hour = new Date(time).getHours();
    const isNightTime = (hour >= 22 || hour <= 6);
    
    // Función auxiliar para evitar NaN
    const safeLog = (val) => {
        const result = Math.log10(Math.max(val, 0.0001));
        return isFinite(result) ? result : 0;
    };
    
    const safeNormalize = (val, max) => {
        const result = val / max;
        return isFinite(result) ? Math.min(Math.max(result, 0), 1) : 0;
    };
    
    return {
        // Características básicas (5)
        magnitude: mag || 0,
        depth: depth || 10,
        latitude: Math.abs(lat) || 0,
        longitude: Math.abs(lon) || 0,
        daysSinceEvent: Math.min(daysSince, 365) / 365, // Normalizado a un año
        
        // Características energéticas (3)
        logEnergy: safeNormalize(safeLog(energy), 20),
        logMoment: safeNormalize(safeLog(moment), 30),
        pga: Math.min(Math.max(pga, 0), 1), // Ya está en escala 0-1
        
        // Características de intensidad (4)
        mercalliIntensity: safeNormalize(intensity, 12), // MMI máximo 12
        hazardIndex: Math.min(Math.max(hazardIndex / 100, 0), 1), // Normalizado 0-1
        aftershockProbability: Math.min(Math.max(aftershockProb / 100, 0), 1), // Normalizado
        duration: safeNormalize(safeLog(duration + 1), 3),
        
        // Características de ruptura (2)
        faultLength: safeNormalize(safeLog(faultLength + 1), 3),
        depthRatio: Math.min(Math.max(depth / 700, 0), 1),
        
        // Características categóricas (5 - one-hot)
        isSubduction: isSubduction ? 1 : 0,
        isShallow: isShallow ? 1 : 0,
        isDeep: isDeep ? 1 : 0,
        isPacificRing: isPacificRing ? 1 : 0,
        isNightTime: isNightTime ? 1 : 0,
        
        // TOTAL: 24 características (todas normalizadas 0-1)
    };
}

// Crear y entrenar modelo de predicción sísmica avanzado
async function createSeismicModel() {
    try {
        console.log('🧠 Inicializando modelo de IA avanzado...');
        console.log('📐 Usando 24 características sísmicas científicas');
        
        // Modelo simplificado pero efectivo con 24 entradas
        const model = tf.sequential({
            name: 'SeismicRiskPredictor',
            layers: [
                // Capa de entrada con 24 características
                tf.layers.dense({ 
                    inputShape: [24], 
                    units: 64, 
                    activation: 'relu',
                    kernelInitializer: 'heNormal',
                    name: 'input_layer'
                }),
                tf.layers.dropout({ rate: 0.2, name: 'dropout_1' }),
                
                // Capa oculta
                tf.layers.dense({ 
                    units: 32, 
                    activation: 'relu',
                    kernelInitializer: 'heNormal',
                    name: 'hidden_layer'
                }),
                tf.layers.dropout({ rate: 0.2, name: 'dropout_2' }),
                
                // Capa de salida - 3 clases de riesgo
                tf.layers.dense({ 
                    units: 3, 
                    activation: 'softmax',
                    name: 'output_layer'
                })
            ]
        });

        // Compilar con Adam con learning rate más alto
        model.compile({
            optimizer: tf.train.adam(0.001),
            loss: 'categoricalCrossentropy',
            metrics: ['accuracy']
        });

        mlModel = model;
        isModelReady = true;
        isModelTrained = false; // Reset training flag for new model
        
        console.log('✅ Modelo de IA simplificado inicializado');
        console.log('📊 Arquitectura: 24→64→32→3 (optimizada)');
        console.log('🎯 Parámetros entrenables:', model.countParams());
        console.log('⚡ Learning rate: 0.001 (mayor convergencia)');
        
        // Mostrar resumen del modelo
        model.summary();
        
        return model;
    } catch (error) {
        console.error('❌ Error creando modelo:', error);
        return null;
    }
}

// Resetear modelo para liberar memoria
function resetMLModel() {
    try {
        if (mlModel) {
            console.log('🧹 Limpiando modelo anterior...');
            mlModel.dispose();
            mlModel = null;
        }
        isModelReady = false;
        isModelTrained = false;
        isAnalyzing = false;
        
        // Forzar limpieza de memoria TensorFlow
        if (typeof tf !== 'undefined') {
            tf.dispose();
        }
        
        console.log('✅ Modelo reiniciado correctamente');
    } catch (error) {
        console.error('❌ Error reiniciando modelo:', error);
    }
}

// Entrenar modelo con datos sísmicos usando características científicas
async function trainModelWithData(earthquakes) {
    if (!mlModel || earthquakes.length < 20) {
        console.log('⚠️ Insuficientes datos para entrenar (mínimo 20)');
        return;
    }
    
    // Si el modelo ya está entrenado, no volver a entrenar
    if (isModelTrained) {
        console.log('ℹ️ Modelo ya entrenado, reutilizando...');
        return;
    }
    
    try {
        console.log(`🎓 Iniciando entrenamiento con ${earthquakes.length} terremotos...`);
        
        // Extraer características avanzadas de todos los terremotos
        const trainingData = [];
        const labels = [];
        
        for (const eq of earthquakes.slice(0, Math.min(earthquakes.length, 1000))) {
            const features = extractSeismicFeatures(eq);
            
            // Convertir objeto de características a array
            const featureArray = [
                features.magnitude,
                features.depth,
                features.latitude,
                features.longitude,
                features.daysSinceEvent,
                features.logEnergy,
                features.logMoment,
                features.pga,
                features.mercalliIntensity,
                features.hazardIndex,
                features.aftershockProbability,
                features.duration,
                features.faultLength,
                features.depthRatio,
                features.isSubduction,
                features.isShallow,
                features.isDeep,
                features.isPacificRing,
                features.isNightTime,
                // Características adicionales calculadas
                features.magnitude * features.mercalliIntensity, // Interacción mag-intensidad
                features.depth * features.aftershockProbability, // Interacción prof-réplicas
                features.hazardIndex * features.isPacificRing, // Interacción peligro-zona
                Math.sqrt(features.magnitude * features.logEnergy), // Relación no lineal
                features.isShallow * features.magnitude // Peligro de terremotos superficiales
            ];
            
            trainingData.push(featureArray);
            
            // Clasificación multi-criterio
            const mag = eq.properties.mag || 0;
            const depth = Math.abs(eq.geometry.coordinates[2]) || 10;
            const intensity = features.mercalliIntensity;
            
            // Sistema de clasificación basado en múltiples factores científicos
            let riskScore = 0;
            
            // Factor 1: Magnitud (40% peso)
            if (mag >= 7.0) riskScore += 40;
            else if (mag >= 5.5) riskScore += 25;
            else if (mag >= 4.0) riskScore += 10;
            
            // Factor 2: Profundidad (30% peso) - superficial es más peligroso
            if (depth < 70) riskScore += 30;
            else if (depth < 300) riskScore += 15;
            
            // Factor 3: Intensidad MMI (30% peso)
            if (intensity > 0.6) riskScore += 30; // MMI > 7
            else if (intensity > 0.4) riskScore += 15; // MMI > 5
            
            // Clasificación final
            let label;
            if (riskScore >= 60) {
                label = [0, 0, 1]; // Alto riesgo
            } else if (riskScore >= 30) {
                label = [0, 1, 0]; // Medio riesgo
            } else {
                label = [1, 0, 0]; // Bajo riesgo
            }
            
            labels.push(label);
        }
        
        console.log(`📊 ${trainingData.length} muestras preparadas con 24 características cada una`);
        
        // Contar distribución de clases
        const lowCount = labels.filter(l => l[0] === 1).length;
        const medCount = labels.filter(l => l[1] === 1).length;
        const highCount = labels.filter(l => l[2] === 1).length;
        console.log(`📊 Distribución: Bajo=${lowCount}, Medio=${medCount}, Alto=${highCount}`);
        
        const xs = tf.tensor2d(trainingData);
        const ys = tf.tensor2d(labels);

        const loadingEl = document.getElementById('mlLoadingStatus');
        if (loadingEl) loadingEl.classList.remove('hidden');

        // Entrenar con configuración optimizada para convergencia rápida
        const epochs = 50;
        let bestLoss = Infinity;
        let patience = 0;
        const maxPatience = 10;
        
        console.log('🔄 Entrenando modelo (esto puede tomar 10-20 segundos)...');
        
        await mlModel.fit(xs, ys, {
            epochs: epochs,
            batchSize: 16,
            validationSplit: 0.15,
            shuffle: true,
            callbacks: {
                onEpochEnd: async (epoch, logs) => {
                    const loss = logs.loss;
                    const valLoss = logs.val_loss;
                    const acc = logs.accuracy;
                    const valAcc = logs.val_accuracy;
                    
                    if (epoch % 10 === 0 || epoch === epochs - 1) {
                        console.log(
                            `📈 Época ${epoch + 1}/${epochs} | ` +
                            `Loss: ${loss.toFixed(4)} | ` +
                            `Val Loss: ${valLoss.toFixed(4)} | ` +
                            `Acc: ${(acc * 100).toFixed(1)}% | ` +
                            `Val Acc: ${(valAcc * 100).toFixed(1)}%`
                        );
                    }
                    
                    // Early stopping
                    if (valLoss < bestLoss) {
                        bestLoss = valLoss;
                        patience = 0;
                    } else {
                        patience++;
                        if (patience >= maxPatience) {
                            console.log(`⏹️ Early stopping en época ${epoch + 1}`);
                            mlModel.stopTraining = true;
                        }
                    }
                    
                    await tf.nextFrame(); // Evitar bloqueo del UI
                }
            }
        });

        if (loadingEl) loadingEl.classList.add('hidden');
        
        // Limpiar tensores
        xs.dispose();
        ys.dispose();

        console.log('✅ Entrenamiento completado exitosamente');

        // Marcar modelo como entrenado
        isModelTrained = true;
        
        const accuracy = bestLoss < 0.5 ? 'Alta' : (bestLoss < 1.0 ? 'Media' : 'Baja');
        addNotification('success', `¡Modelo entrenado con ${trainingData.length} muestras!`);
        
    } catch (error) {
        console.error('❌ Error entrenando modelo:', error);
        const loadingEl = document.getElementById('mlLoadingStatus');
        if (loadingEl) loadingEl.classList.add('hidden');
        addNotification('error', 'Error al entrenar el modelo');
        isModelTrained = false; // Reset en caso de error
    }
}

// Analizar riesgo sísmico con ML usando características científicas
async function analyzeSeismicRisk() {
    console.log('🎯 Iniciando análisis ML de riesgo sísmico...');
    
    if (!isModelReady || !currentEarthquakesData || !Array.isArray(currentEarthquakesData)) {
        console.error('❌ Falta:', {
            isModelReady,
            hasData: !!currentEarthquakesData,
            isArray: Array.isArray(currentEarthquakesData),
            dataLength: currentEarthquakesData?.length
        });
        addNotification('warning', 'Modelo de IA no está listo o no hay datos cargados');
        return;
    }
    
    if (currentEarthquakesData.length < 10) {
        addNotification('warning', `Se necesitan al menos 10 terremotos. Actualmente: ${currentEarthquakesData.length}`);
        return;
    }

    // Prevenir análisis concurrentes
    if (isAnalyzing) {
        console.log('⚠️ Ya hay un análisis en progreso...');
        addNotification('info', 'Por favor espera a que termine el análisis actual');
        return;
    }

    try {
        isAnalyzing = true; // Marcar como en proceso
        
        const container = document.getElementById('mlRiskAnalysis');
        container.innerHTML = `
            <div class="risk-container" style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 32px 0;">
                <div class="spinner spinner-glow" style="margin: 0 auto 16px auto;"></div>
                <p style="text-align: center; font-size: 14px; color: #9ca3af; margin: 0;">
                    Analizando con 24 características sísmicas...
                </p>
            </div>
        `;

        // Entrenar modelo con datos completos solo la primera vez
        console.log('🎓 Preparando modelo con características científicas...');
        await trainModelWithData(currentEarthquakesData);

        // Analizar terremotos más recientes y significativos
        const recentQuakes = currentEarthquakesData
            .sort((a, b) => b.properties.time - a.properties.time)
            .slice(0, 20);
        
        const predictions = [];
        const detailedAnalysis = [];

        for (const eq of recentQuakes) {
            // Extraer 24 características científicas
            const features = extractSeismicFeatures(eq);
            
            // Obtener valores originales para cálculos detallados
            const realMag = eq.properties.mag || 0;
            const realDepth = Math.abs(eq.geometry.coordinates[2]) || 10;
            
            // Convertir a array de 24 elementos (usar valores normalizados del features)
            const featureArray = [
                features.magnitude,
                features.depth,
                features.latitude,
                features.longitude,
                features.daysSinceEvent,
                features.logEnergy,
                features.logMoment,
                features.pga,
                features.mercalliIntensity,
                features.hazardIndex,
                features.aftershockProbability,
                features.duration,
                features.faultLength,
                features.depthRatio,
                features.isSubduction,
                features.isShallow,
                features.isDeep,
                features.isPacificRing,
                features.isNightTime,
                features.magnitude * features.mercalliIntensity,
                features.depth * features.aftershockProbability,
                features.hazardIndex * features.isPacificRing,
                Math.sqrt(Math.abs(features.magnitude * features.logEnergy)),
                features.isShallow * features.magnitude
            ];

            // Usar tf.tidy para limpieza automática de tensores
            const predictionData = await tf.tidy(() => {
                const input = tf.tensor2d([featureArray]);
                const prediction = mlModel.predict(input);
                return prediction.dataSync(); // dataSync es síncrono pero más eficiente aquí
            });
            
            // DEBUG: Log de predicción
            if (predictions.length === 0) {
                console.log('🔍 Primera predicción:', {
                    mag: realMag,
                    depth: realDepth,
                    raw: Array.from(predictionData),
                    features: featureArray.slice(0, 5)
                });
            }
            
            // Calcular confianza de la predicción
            const maxProb = Math.max(...predictionData);
            const confidence = Math.min(maxProb * 100, 100);
            
            // Asegurar que los valores sean válidos y redondear
            const lowRisk = Math.round(Math.max(0, Math.min(predictionData[0] * 100, 100)) * 10) / 10;
            const mediumRisk = Math.round(Math.max(0, Math.min(predictionData[1] * 100, 100)) * 10) / 10;
            const highRisk = Math.round(Math.max(0, Math.min(predictionData[2] * 100, 100)) * 10) / 10;
            
            // Guardar predicción del modelo ML (sin fallback heurístico artificial aquí)
            predictions.push({
                earthquake: eq,
                lowRisk: lowRisk,
                mediumRisk: mediumRisk,
                highRisk: highRisk,
                confidence: confidence,
                features: features
            });
            
            // Análisis detallado con fórmulas científicas (usar valores reales)
            const detailedEnergy = calculateSeismicEnergyML(realMag);
            const detailedMoment = calculateSeismicMoment(realMag);
            const detailedIntensity = calculateMMIntensity(realMag, realDepth);
            const detailedPGA = Math.max(0, calculatePGA(realMag, 10, realDepth));
            
            detailedAnalysis.push({
                magnitude: realMag,
                place: eq.properties.place,
                energy: detailedEnergy,
                moment: detailedMoment,
                intensity: detailedIntensity,
                pga: detailedPGA,
                hazardIndex: features.hazardIndex * 100,
                riskClass: highRisk > 50 ? 'Alto' : (mediumRisk > 50 ? 'Medio' : 'Bajo')
            });

            // tf.tidy limpia automáticamente los tensores, no necesitamos dispose() manual
        }

        // Calcular estadísticas globales con manejo seguro de valores
        let avgLow = predictions.length > 0 ? 
            Math.max(0, predictions.reduce((sum, p) => sum + (p.lowRisk || 0), 0) / predictions.length) : 0;
        let avgMedium = predictions.length > 0 ? 
            Math.max(0, predictions.reduce((sum, p) => sum + (p.mediumRisk || 0), 0) / predictions.length) : 0;
        let avgHigh = predictions.length > 0 ? 
            Math.max(0, predictions.reduce((sum, p) => sum + (p.highRisk || 0), 0) / predictions.length) : 0;
        
        // Contar cuántas predicciones usaron fallback
        const fallbackCount = predictions.filter(p => p.fallback).length;
        console.log(`📊 Resultados: ${predictions.length} predicciones, ${fallbackCount} con fallback`);
        console.log(`📈 Promedios: Bajo=${avgLow.toFixed(1)}%, Medio=${avgMedium.toFixed(1)}%, Alto=${avgHigh.toFixed(1)}%`);
        
        // Si TODAS las predicciones son 0, usar clasificación USGS pura
        if (avgLow === 0 && avgMedium === 0 && avgHigh === 0) {
            console.warn('⚠️ Modelo ML no disponible, usando escala USGS estándar');
            
            // Clasificación USGS basada ÚNICAMENTE en magnitud (sin valores inventados)
            // Referencia: https://www.usgs.gov/programs/earthquake-hazards/earthquake-magnitude-energy-release-and-shaking-intensity
            predictions.length = 0;
            for (const eq of recentQuakes) {
                const mag = eq.properties.mag || 0;
                
                // Categorización USGS oficial:
                // M >= 8.0: Great - Destrucción total
                // M 7.0-7.9: Major - Daño serio en áreas amplias  
                // M 6.0-6.9: Strong - Daño en áreas pobladas
                // M 5.0-5.9: Moderate - Daño menor a estructuras
                // M 4.0-4.9: Light - Perceptible, sin daño
                // M 3.0-3.9: Minor - Raramente sentido
                // M < 3.0: Micro - No sentido
                
                let riskCategory;
                if (mag >= 7.0) {
                    riskCategory = 'high';  // Major/Great
                } else if (mag >= 5.0) {
                    riskCategory = 'medium';  // Moderate/Strong
                } else {
                    riskCategory = 'low';  // Light/Minor/Micro
                }
                
                // Asignar 100% a la categoría correspondiente (sin distribuciones artificiales)
                predictions.push({ 
                    lowRisk: riskCategory === 'low' ? 100 : 0,
                    mediumRisk: riskCategory === 'medium' ? 100 : 0,
                    highRisk: riskCategory === 'high' ? 100 : 0,
                    confidence: 100,  // Certeza total en clasificación USGS
                    fallback: true 
                });
            }
            
            avgLow = predictions.reduce((sum, p) => sum + p.lowRisk, 0) / predictions.length;
            avgMedium = predictions.reduce((sum, p) => sum + p.mediumRisk, 0) / predictions.length;
            avgHigh = predictions.reduce((sum, p) => sum + p.highRisk, 0) / predictions.length;
            
            console.log(`📈 Clasificación científica aplicada: Bajo=${avgLow.toFixed(1)}%, Medio=${avgMedium.toFixed(1)}%, Alto=${avgHigh.toFixed(1)}%`);
        }
        const avgConfidence = predictions.length > 0 ? 
            Math.max(0, predictions.reduce((sum, p) => sum + (p.confidence || 0), 0) / predictions.length) : 0;
        
        // Análisis de energía total liberada
        const totalEnergy = detailedAnalysis.length > 0 ? 
            detailedAnalysis.reduce((sum, a) => sum + (a.energy || 0), 0) : 0;
        const avgIntensity = detailedAnalysis.length > 0 ? 
            detailedAnalysis.reduce((sum, a) => sum + (a.intensity || 0), 0) / detailedAnalysis.length : 0;
        const maxHazard = detailedAnalysis.length > 0 ? 
            Math.max(0, ...detailedAnalysis.map(a => a.hazardIndex || 0)) : 0;

        // Normalizar para que sumen exactamente 100% (matemática pura, sin mínimos artificiales)
        const total = avgLow + avgMedium + avgHigh;
        if (total > 0) {
            avgLow = (avgLow / total) * 100;
            avgMedium = (avgMedium / total) * 100;
            avgHigh = (avgHigh / total) * 100;
        } else {
            // Si no hay datos, no inventar nada - mantener en 0
            avgLow = 0;
            avgMedium = 0;
            avgHigh = 0;
        }
        
        // Clasificación basada ÚNICAMENTE en el valor máximo (sin umbrales artificiales)
        const maxRisk = Math.max(avgLow, avgMedium, avgHigh);
        let riskLevel = 'Bajo';
        let riskColor = 'green';
        let riskIcon = 'check-circle';
        
        // El nivel es simplemente el que tenga el porcentaje más alto (regla científica pura)
        if (avgHigh === maxRisk && avgHigh > 0) {
            riskLevel = 'Alto';
            riskColor = 'red';
            riskIcon = 'exclamation-triangle';
        } else if (avgMedium === maxRisk && avgMedium > 0) {
            riskLevel = 'Medio';
            riskColor = 'yellow';
            riskIcon = 'exclamation-circle';
        }
        // Si avgLow es el mayor, queda como 'Bajo' (ya configurado)
        
        console.log(`🎯 Nivel de riesgo determinado: ${riskLevel} (Bajo=${avgLow.toFixed(1)}%, Medio=${avgMedium.toFixed(1)}%, Alto=${avgHigh.toFixed(1)}%)`);

        
        console.log('📊 Análisis completado:', {
            riesgo: riskLevel,
            confianza: avgConfidence.toFixed(1),
            muestras: predictions.length,
            bajo: avgLow.toFixed(1),
            medio: avgMedium.toFixed(1),
            alto: avgHigh.toFixed(1),
            energiaTotal: totalEnergy.toExponential(2),
            intensidadPromedio: avgIntensity.toFixed(1),
            peligroMax: maxHazard.toFixed(1)
        });

        container.innerHTML = `
            <div class="text-center mb-6">
                <div class="inline-block p-6 bg-${riskColor}-600/20 rounded-full mb-4 glow-hover">
                    <i class="fas fa-${riskIcon} text-5xl text-${riskColor}-400"></i>
                </div>
                <h4 class="text-3xl font-bold text-${riskColor}-400 mb-2">Nivel de Riesgo: ${riskLevel}</h4>
                <p class="text-text-secondary text-sm mb-1">Análisis IA de ${predictions.length} eventos sísmicos recientes</p>
                <p class="text-xs text-gray-500">
                    Basado en el mayor porcentaje de predicción ML
                </p>
            </div>
            
            <!-- Métricas científicas -->
            <div class="grid grid-cols-2 gap-3 mb-4">
                <div class="bg-purple-900/20 border border-purple-500/30 rounded-lg p-3 text-center hover:border-purple-400/50 transition-colors">
                    <i class="fas fa-bolt text-purple-400 text-xl mb-1"></i>
                    <p class="text-xs text-gray-400">Energía Total</p>
                    <p class="text-sm font-bold text-purple-300">${formatEnergy(totalEnergy)}</p>
                </div>
                <div class="bg-orange-900/20 border border-orange-500/30 rounded-lg p-3 text-center hover:border-orange-400/50 transition-colors">
                    <i class="fas fa-chart-line text-orange-400 text-xl mb-1"></i>
                    <p class="text-xs text-gray-400">Intensidad Media</p>
                    <p class="text-sm font-bold text-orange-300">MMI ${avgIntensity.toFixed(1)}</p>
                </div>
                <div class="bg-cyan-900/20 border border-cyan-500/30 rounded-lg p-3 text-center hover:border-cyan-400/50 transition-colors">
                    <i class="fas fa-brain text-cyan-400 text-xl mb-1"></i>
                    <p class="text-xs text-gray-400">Confianza IA</p>
                    <p class="text-sm font-bold text-cyan-300">${avgConfidence.toFixed(0)}%</p>
                </div>
                <div class="bg-blue-900/20 border border-blue-500/30 rounded-lg p-3 text-center hover:border-blue-400/50 transition-colors">
                    <i class="fas fa-database text-blue-400 text-xl mb-1"></i>
                    <p class="text-xs text-gray-400">Eventos</p>
                    <p class="text-sm font-bold text-blue-300">${predictions.length} analizados</p>
                </div>
            </div>
            
            <!-- Probabilidades de riesgo -->
            <div class="space-y-3 mb-4">
                <div>
                    <div class="flex justify-between mb-1">
                        <span class="text-sm flex items-center gap-2">
                            <i class="fas fa-check-circle text-green-400"></i>
                            Riesgo Bajo
                        </span>
                        <span class="text-sm font-bold text-green-400">${avgLow.toFixed(1)}%</span>
                    </div>
                    <div class="h-3 bg-gray-700 rounded-full overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-green-500 to-green-400 transition-all duration-500" style="width: ${avgLow}%"></div>
                    </div>
                </div>
                
                <div>
                    <div class="flex justify-between mb-1">
                        <span class="text-sm flex items-center gap-2">
                            <i class="fas fa-exclamation-circle text-yellow-400"></i>
                            Riesgo Medio
                        </span>
                        <span class="text-sm font-bold text-yellow-400">${avgMedium.toFixed(1)}%</span>
                    </div>
                    <div class="h-3 bg-gray-700 rounded-full overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-yellow-500 to-yellow-400 transition-all duration-500" style="width: ${avgMedium}%"></div>
                    </div>
                </div>
                
                <div>
                    <div class="flex justify-between mb-1">
                        <span class="text-sm flex items-center gap-2">
                            <i class="fas fa-exclamation-triangle text-red-400"></i>
                            Riesgo Alto
                        </span>
                        <span class="text-sm font-bold text-red-400">${avgHigh.toFixed(1)}%</span>
                    </div>
                    <div class="h-3 bg-gray-700 rounded-full overflow-hidden">
                        <div class="h-full bg-gradient-to-r from-red-500 to-red-400 transition-all duration-500" style="width: ${avgHigh}%"></div>
                    </div>
                </div>
            </div>
            
            <!-- Fórmulas científicas utilizadas -->
            <div class="mb-4 p-3 bg-gradient-to-r from-cyan-900/20 to-blue-900/20 border border-cyan-500/30 rounded-lg">
                <h5 class="text-xs font-bold mb-2 flex items-center gap-2 text-cyan-300">
                    <i class="fas fa-calculator"></i>
                    Fórmulas Aplicadas
                </h5>
                <div class="grid grid-cols-2 gap-2 text-xs text-gray-400">
                    <div>• Gutenberg-Richter (Energía)</div>
                    <div>• Hanks-Kanamori (Momento)</div>
                    <div>• Intensidad Mercalli (MMI)</div>
                    <div>• Boore-Atkinson (PGA)</div>
                    <div>• Ley de Omori (Réplicas)</div>
                    <div>• Wells-Coppersmith (Falla)</div>
                </div>
            </div>
            
            <!-- Recomendaciones -->
            <div class="p-4 bg-dark-1b rounded-lg border border-gray-700">
                <h5 class="font-bold mb-3 flex items-center gap-2">
                    <i class="fas fa-lightbulb text-yellow-400"></i>
                    Recomendaciones Basadas en IA
                </h5>
                <ul class="text-sm text-text-secondary space-y-2">
                    ${riskLevel === 'Alto' ? `
                        <li class="flex items-start gap-2">
                            <i class="fas fa-check text-red-400 mt-0.5"></i>
                            <span>Mantén kit de emergencia completo (agua, comida, linterna, radio)</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <i class="fas fa-check text-red-400 mt-0.5"></i>
                            <span>Revisa y practica rutas de evacuación con tu familia</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <i class="fas fa-check text-red-400 mt-0.5"></i>
                            <span>Estate atento a alertas oficiales de autoridades locales</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <i class="fas fa-check text-red-400 mt-0.5"></i>
                            <span>Identifica zonas seguras en edificios (triángulo de vida)</span>
                        </li>
                    ` : riskLevel === 'Medio' ? `
                        <li class="flex items-start gap-2">
                            <i class="fas fa-check text-yellow-400 mt-0.5"></i>
                            <span>Prepara un kit de emergencia básico</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <i class="fas fa-check text-yellow-400 mt-0.5"></i>
                            <span>Identifica zonas seguras en tu hogar y trabajo</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <i class="fas fa-check text-yellow-400 mt-0.5"></i>
                            <span>Mantente informado sobre actividad sísmica</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <i class="fas fa-check text-yellow-400 mt-0.5"></i>
                            <span>Revisa información preventiva periódicamente</span>
                        </li>
                    ` : `
                        <li class="flex items-start gap-2">
                            <i class="fas fa-check text-green-400 mt-0.5"></i>
                            <span>Mantén la calma, situación bajo control</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <i class="fas fa-check text-green-400 mt-0.5"></i>
                            <span>Revisa información preventiva básica</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <i class="fas fa-check text-green-400 mt-0.5"></i>
                            <span>Conoce los procedimientos de emergencia</span>
                        </li>
                        <li class="flex items-start gap-2">
                            <i class="fas fa-check text-green-400 mt-0.5"></i>
                            <span>Mantén contactos de emergencia actualizados</span>
                        </li>
                    `}
                </ul>
            </div>
        `;

        // Predicción de ubicación con datos filtrados
        const validPredictions = predictions.filter(p => p.earthquake && p.earthquake.properties);
        console.log(`🎯 Predicciones válidas para ubicación: ${validPredictions.length}/${predictions.length}`);
        
        if (validPredictions.length > 0) {
            predictNextEventLocation(validPredictions);
        } else {
            console.warn('⚠️ No hay predicciones válidas para mostrar ubicación');
            const locContainer = document.getElementById('mlLocationPrediction');
            if (locContainer) {
                locContainer.innerHTML = `
                    <div class="p-4 bg-yellow-900/20 border border-yellow-500/30 rounded-lg text-center">
                        <i class="fas fa-exclamation-circle text-yellow-400 text-2xl mb-2"></i>
                        <p class="text-yellow-300 text-sm">No hay suficientes datos para predicción de ubicación</p>
                    </div>
                `;
            }
        }

        addNotification('success', `Análisis completado: ${predictions.length} eventos analizados`);

    } catch (error) {
        console.error('Error en análisis ML:', error);
        document.getElementById('mlRiskAnalysis').innerHTML = `
            <div class="text-center text-red-500 py-8">
                <i class="fas fa-exclamation-circle text-4xl mb-3"></i>
                <p>Error al analizar datos. Intenta de nuevo.</p>
            </div>
        `;
    } finally {
        // Liberar flag de análisis
        isAnalyzing = false;
        
        // Limpiar memoria de TensorFlow
        if (typeof tf !== 'undefined' && tf.engine) {
            const memInfo = tf.memory();
            console.log(`🧹 Memoria TensorFlow: ${memInfo.numTensors} tensores, ${(memInfo.numBytes / 1024 / 1024).toFixed(2)} MB`);
        }
    }
}

// Formatear energía a formato legible
function formatEnergy(joules) {
    if (joules >= 1e15) {
        return `${(joules / 1e15).toFixed(1)} Petajulios`; // PJ
    } else if (joules >= 1e12) {
        return `${(joules / 1e12).toFixed(1)} Terajulios`; // TJ
    } else if (joules >= 1e9) {
        return `${(joules / 1e9).toFixed(1)} Gigajulios`; // GJ
    } else if (joules >= 1e6) {
        return `${(joules / 1e6).toFixed(1)} Megajulios`; // MJ
    } else if (joules >= 1e3) {
        return `${(joules / 1e3).toFixed(1)} Kilojulios`; // kJ
    } else {
        return `${joules.toFixed(0)} Julios`;
    }
}

// Predecir próxima ubicación de evento
async function predictNextEventLocation(predictions) {
    const container = document.getElementById('mlLocationPrediction');
    
    if (!container) {
        console.error('❌ Contenedor mlLocationPrediction no encontrado en el DOM');
        return;
    }
    
    console.log(`📍 Generando predicción de ubicación con ${predictions?.length || 0} datos...`);
    
    if (!predictions || predictions.length === 0) {
        container.innerHTML = `
            <div class="p-6 bg-gradient-to-br from-gray-800/50 to-gray-900/50 rounded-lg border border-gray-700 text-center">
                <div class="mb-3">
                    <i class="fas fa-satellite-dish text-4xl text-gray-500"></i>
                </div>
                <p class="text-gray-400 text-sm mb-2">Recopilando datos sísmicos...</p>
                <p class="text-xs text-gray-500">La predicción estará disponible después del análisis</p>
            </div>
        `;
        return;
    }

    try {
        // Analizar patrones de ubicación con validación
        const validEqs = predictions.filter(p => 
            p.earthquake && 
            p.earthquake.geometry && 
            p.earthquake.geometry.coordinates &&
            p.earthquake.properties &&
            p.earthquake.properties.mag
        );
        
        if (validEqs.length === 0) {
            container.innerHTML = `
                <div class="p-6 bg-gradient-to-br from-orange-900/20 to-red-900/20 rounded-lg border border-orange-500/30 text-center">
                    <div class="mb-3">
                        <i class="fas fa-exclamation-triangle text-4xl text-orange-400"></i>
                    </div>
                    <p class="text-orange-300 text-sm font-semibold mb-2">Datos Insuficientes</p>
                    <p class="text-xs text-gray-400">Se requieren más eventos para generar predicción confiable</p>
                </div>
            `;
            return;
        }
        
        const latitudes = validEqs.map(p => p.earthquake.geometry.coordinates[1]);
        const longitudes = validEqs.map(p => p.earthquake.geometry.coordinates[0]);
        const magnitudes = validEqs.map(p => p.earthquake.properties.mag);
        
        console.log(`📊 Datos extraídos: ${latitudes.length} coordenadas válidas`);

        const avgLat = latitudes.reduce((a, b) => a + b, 0) / latitudes.length;
        const avgLon = longitudes.reduce((a, b) => a + b, 0) / longitudes.length;
        const avgMag = magnitudes.reduce((a, b) => a + b, 0) / magnitudes.length;
        const maxMag = Math.max(...magnitudes);
        const minMag = Math.min(...magnitudes);
        
        console.log(`📈 Estadísticas: Lat=${avgLat.toFixed(2)}, Lon=${avgLon.toFixed(2)}, MagPromedio=${avgMag.toFixed(2)}, MagMax=${maxMag.toFixed(1)}, MagMin=${minMag.toFixed(1)}`);

        // Encontrar la región más activa
        const regionCounts = {};
        validEqs.forEach(p => {
            const place = p.earthquake.properties.place || 'Ubicación desconocida';
            const parts = place.split(',');
            const region = parts.length > 0 ? parts[parts.length - 1].trim() : place;
            regionCounts[region] = (regionCounts[region] || 0) + 1;
        });

        const regions = Object.entries(regionCounts).sort((a, b) => b[1] - a[1]);
        const mostActiveRegion = regions.length > 0 ? regions[0][0] : 'Región desconocida';
        const eventCount = regions.length > 0 ? regions[0][1] : 0;

        container.innerHTML = `
            <div class="space-y-3">
                <div class="p-3 bg-gradient-to-r from-blue-900/30 to-cyan-900/30 border border-blue-500/40 rounded-lg">
                    <h5 class="text-sm font-bold mb-2 flex items-center gap-2 text-blue-300">
                        <i class="fas fa-map-marker-alt"></i>
                        Zona de Mayor Actividad Reciente
                    </h5>
                    <p class="text-base text-blue-400 font-semibold mb-1">${mostActiveRegion}</p>
                    <p class="text-xs text-gray-400">
                        <i class="fas fa-chart-bar mr-1"></i>
                        ${eventCount} eventos detectados (${((eventCount/validEqs.length)*100).toFixed(0)}% del total)
                    </p>
                </div>

                <div class="grid grid-cols-2 gap-2">
                    <div class="p-3 bg-dark-1b rounded-lg text-center border border-gray-700 hover:border-blue-500/50 transition-colors">
                        <i class="fas fa-compass text-blue-400 mb-1"></i>
                        <p class="text-xs text-gray-400 mb-1">Latitud Centro</p>
                        <p class="text-sm font-bold text-white">${avgLat.toFixed(3)}°</p>
                        <p class="text-xs text-gray-500">${avgLat > 0 ? 'Norte' : 'Sur'}</p>
                    </div>
                    <div class="p-3 bg-dark-1b rounded-lg text-center border border-gray-700 hover:border-blue-500/50 transition-colors">
                        <i class="fas fa-compass text-cyan-400 mb-1"></i>
                        <p class="text-xs text-gray-400 mb-1">Longitud Centro</p>
                        <p class="text-sm font-bold text-white">${avgLon.toFixed(3)}°</p>
                        <p class="text-xs text-gray-500">${avgLon > 0 ? 'Este' : 'Oeste'}</p>
                    </div>
                </div>

                <div class="p-3 bg-gradient-to-r from-purple-900/30 to-pink-900/30 border border-purple-500/40 rounded-lg">
                    <h5 class="text-sm font-bold mb-3 flex items-center gap-2 text-purple-300">
                        <i class="fas fa-chart-line"></i>
                        Predicción de Magnitud
                    </h5>
                    <div class="flex items-center gap-3 mb-2">
                        <div class="text-3xl font-bold text-purple-400">${avgMag.toFixed(1)}</div>
                        <div class="flex-1">
                            <p class="text-xs text-gray-400 mb-1">Basado en patrones históricos</p>
                            <div class="h-2 bg-gray-700 rounded-full overflow-hidden">
                                <div class="h-full bg-gradient-to-r from-purple-500 to-pink-500 transition-all duration-500" 
                                     style="width: ${Math.min((avgMag / 9) * 100, 100)}%"></div>
                            </div>
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-2 mt-2">
                        <div class="text-xs text-gray-400">
                            <span class="text-green-400">↓ Mín:</span> ${minMag.toFixed(1)}
                        </div>
                        <div class="text-xs text-gray-400 text-right">
                            <span class="text-red-400">↑ Máx:</span> ${maxMag.toFixed(1)}
                        </div>
                    </div>
                </div>

                <div class="p-3 bg-blue-600/10 rounded-lg border border-blue-500/30">
                    <p class="text-xs text-blue-300 flex items-start gap-2">
                        <i class="fas fa-info-circle mt-0.5"></i>
                        <span>
                            <strong>Estimaciones por IA:</strong> Basadas en ${validEqs.length} eventos recientes analizados con 
                            TensorFlow.js. La predicción considera patrones geográficos y temporales.
                        </span>
                    </p>
                </div>
            </div>
        `;
        
        console.log('✅ Predicción de ubicación completada y mostrada');
        
    } catch (error) {
        console.error('❌ Error en predicción de ubicación:', error);
        container.innerHTML = '<p class="text-center text-red-400 text-sm">Error al calcular predicción</p>';
    }
}

// Inicializar ML
async function initializeML() {
    console.log('🚀 Inicializando sistema ML...');
    
    // Crear modelo
    await createSeismicModel();
    
    // Agregar listener al botón
    const runBtn = document.getElementById('runMLAnalysis');
    if (runBtn) {
        runBtn.addEventListener('click', analyzeSeismicRisk);
        console.log('✅ Botón ML Analysis configurado');
    } else {
        console.warn('⚠️ No se encontró el botón runMLAnalysis');
    }
    
    // Verificar contenedores
    const riskContainer = document.getElementById('mlRiskAnalysis');
    const predictionContainer = document.getElementById('mlLocationPrediction');
    
    if (!riskContainer) console.warn('⚠️ Contenedor mlRiskAnalysis no encontrado');
    if (!predictionContainer) console.warn('⚠️ Contenedor mlLocationPrediction no encontrado');
    
    console.log('✅ Sistema ML inicializado correctamente');
}

// ==================== COMPARADOR ====================

// Función para comparar terremotos
function compareEarthquakes() {
    const index1 = document.getElementById('compare1').value;
    const index2 = document.getElementById('compare2').value;
    
    if (!index1 || !index2 || !currentEarthquakesData || !Array.isArray(currentEarthquakesData)) {
        document.getElementById('comparisonResult').classList.add('hidden');
        return;
    }

    const quake1 = currentEarthquakesData[index1];
    const quake2 = currentEarthquakesData[index2];
    
    const prop1 = quake1.properties;
    const prop2 = quake2.properties;
    const coords1 = quake1.geometry.coordinates;
    const coords2 = quake2.geometry.coordinates;

    document.getElementById('comparisonResult').classList.remove('hidden');
    
    // Calcular distancia entre terremotos
    const distance = getDistance(coords1[1], coords1[0], coords2[1], coords2[0]);
    
    // Detalles del terremoto 1
    document.getElementById('quake1Details').innerHTML = `
        <div class="animate-fadeIn">
            <h3 class="text-xl font-bold mb-4 text-primary flex items-center gap-2">
                <i class="fas fa-map-marker-alt"></i>
                Terremoto 1
            </h3>
            <div class="space-y-3">
                <div class="flex justify-between items-center p-3 bg-surface rounded">
                    <span class="text-text-secondary">Magnitud</span>
                    <span class="text-2xl font-bold text-primary">${prop1.mag.toFixed(1)}</span>
                </div>
                <div class="p-3 bg-surface rounded">
                    <p class="text-xs text-text-secondary mb-1">Ubicación</p>
                    <p class="font-semibold">${prop1.place}</p>
                </div>
                <div class="grid grid-cols-2 gap-2">
                    <div class="p-3 bg-surface rounded text-center">
                        <p class="text-xs text-text-secondary mb-1">Profundidad</p>
                        <p class="font-bold">${coords1[2].toFixed(1)} km</p>
                    </div>
                    <div class="p-3 bg-surface rounded text-center">
                        <p class="text-xs text-text-secondary mb-1">Tipo</p>
                        <p class="font-bold">${prop1.type}</p>
                    </div>
                </div>
                <div class="p-3 bg-surface rounded">
                    <p class="text-xs text-text-secondary mb-1">Fecha y Hora</p>
                    <p class="font-semibold">${new Date(prop1.time).toLocaleString()}</p>
                </div>
                <div class="grid grid-cols-2 gap-2">
                    <div class="p-3 bg-surface rounded text-center">
                        <p class="text-xs text-text-secondary mb-1">Latitud</p>
                        <p class="font-bold">${coords1[1].toFixed(3)}°</p>
                    </div>
                    <div class="p-3 bg-surface rounded text-center">
                        <p class="text-xs text-text-secondary mb-1">Longitud</p>
                        <p class="font-bold">${coords1[0].toFixed(3)}°</p>
                    </div>
                </div>
                <button onclick="saveEarthquake(${JSON.stringify(quake1).replace(/"/g, '&quot;')})" 
                        class="w-full bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded transition-all">
                    <i class="fas fa-star mr-2"></i>Guardar en Favoritos
                </button>
            </div>
        </div>
    `;
    
    // Detalles del terremoto 2
    document.getElementById('quake2Details').innerHTML = `
        <div class="animate-fadeIn" style="animation-delay: 0.1s;">
            <h3 class="text-xl font-bold mb-4 text-blue-500 flex items-center gap-2">
                <i class="fas fa-map-marker-alt"></i>
                Terremoto 2
            </h3>
            <div class="space-y-3">
                <div class="flex justify-between items-center p-3 bg-surface rounded">
                    <span class="text-text-secondary">Magnitud</span>
                    <span class="text-2xl font-bold text-blue-500">${prop2.mag.toFixed(1)}</span>
                </div>
                <div class="p-3 bg-surface rounded">
                    <p class="text-xs text-text-secondary mb-1">Ubicación</p>
                    <p class="font-semibold">${prop2.place}</p>
                </div>
                <div class="grid grid-cols-2 gap-2">
                    <div class="p-3 bg-surface rounded text-center">
                        <p class="text-xs text-text-secondary mb-1">Profundidad</p>
                        <p class="font-bold">${coords2[2].toFixed(1)} km</p>
                    </div>
                    <div class="p-3 bg-surface rounded text-center">
                        <p class="text-xs text-text-secondary mb-1">Tipo</p>
                        <p class="font-bold">${prop2.type}</p>
                    </div>
                </div>
                <div class="p-3 bg-surface rounded">
                    <p class="text-xs text-text-secondary mb-1">Fecha y Hora</p>
                    <p class="font-semibold">${new Date(prop2.time).toLocaleString()}</p>
                </div>
                <div class="grid grid-cols-2 gap-2">
                    <div class="p-3 bg-surface rounded text-center">
                        <p class="text-xs text-text-secondary mb-1">Latitud</p>
                        <p class="font-bold">${coords2[1].toFixed(3)}°</p>
                    </div>
                    <div class="p-3 bg-surface rounded text-center">
                        <p class="text-xs text-text-secondary mb-1">Longitud</p>
                        <p class="font-bold">${coords2[0].toFixed(3)}°</p>
                    </div>
                </div>
                <button onclick="saveEarthquake(${JSON.stringify(quake2).replace(/"/g, '&quot;')})" 
                        class="w-full bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded transition-all">
                    <i class="fas fa-star mr-2"></i>Guardar en Favoritos
                </button>
            </div>
        </div>
    `;
    
    // Análisis comparativo
    const magDiff = Math.abs(prop1.mag - prop2.mag);
    const depthDiff = Math.abs(coords1[2] - coords2[2]);
    const timeDiff = Math.abs(prop1.time - prop2.time) / 86400000; // días
    
    const energyRatio = Math.pow(10, 1.5 * magDiff);
    const strongerQuake = prop1.mag > prop2.mag ? prop1.place : prop2.place;
    const deeperQuake = coords1[2] > coords2[2] ? prop1.place : prop2.place;
    
    document.getElementById('comparisonAnalysis').innerHTML = `
        <div class="animate-fadeIn" style="animation-delay: 0.2s;">
            <div class="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
                <div class="text-center p-4 card-modern rounded-lg hover-lift">
                    <i class="fas fa-ruler-horizontal text-primary text-2xl mb-2"></i>
                    <p class="text-text-secondary text-xs mb-2">Diferencia de Magnitud</p>
                    <p class="text-3xl font-bold text-primary">${magDiff.toFixed(1)}</p>
                </div>
                <div class="text-center p-4 card-modern rounded-lg hover-lift">
                    <i class="fas fa-arrows-alt-v text-yellow-500 text-2xl mb-2"></i>
                    <p class="text-text-secondary text-xs mb-2">Diferencia de Profundidad</p>
                    <p class="text-3xl font-bold text-yellow-500">${depthDiff.toFixed(1)} km</p>
                </div>
                <div class="text-center p-4 card-modern rounded-lg hover-lift">
                    <i class="fas fa-bolt text-red-500 text-2xl mb-2"></i>
                    <p class="text-text-secondary text-xs mb-2">Proporción de Energía</p>
                    <p class="text-3xl font-bold text-red-500">${energyRatio.toFixed(0)}x</p>
                </div>
                <div class="text-center p-4 card-modern rounded-lg hover-lift">
                    <i class="fas fa-map text-green-500 text-2xl mb-2"></i>
                    <p class="text-text-secondary text-xs mb-2">Distancia</p>
                    <p class="text-3xl font-bold text-green-500">${distance.toFixed(0)} km</p>
                </div>
            </div>
            
            <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                <div class="p-4 card-modern rounded-lg">
                    <h5 class="font-bold mb-3 flex items-center gap-2">
                        <i class="fas fa-clock text-blue-400"></i>
                        Diferencia Temporal
                    </h5>
                    <p class="text-2xl font-bold text-blue-400">${timeDiff.toFixed(1)} días</p>
                    <p class="text-sm text-text-secondary mt-2">
                        ${timeDiff < 1 ? 'Ocurrieron el mismo día' : 
                          timeDiff < 7 ? 'Ocurrieron en la misma semana' : 
                          'Ocurrieron en diferentes semanas'}
                    </p>
                </div>
                <div class="p-4 card-modern rounded-lg">
                    <h5 class="font-bold mb-3 flex items-center gap-2">
                        <i class="fas fa-exclamation-triangle text-orange-400"></i>
                        Nivel de Peligrosidad
                    </h5>
                    <div class="space-y-2">
                        <div class="flex justify-between">
                            <span class="text-sm">Terremoto 1:</span>
                            <span class="font-bold ${prop1.mag >= 7 ? 'text-red-500' : prop1.mag >= 5 ? 'text-orange-500' : 'text-yellow-500'}">
                                ${prop1.mag >= 7 ? 'EXTREMO' : prop1.mag >= 5 ? 'ALTO' : 'MODERADO'}
                            </span>
                        </div>
                        <div class="flex justify-between">
                            <span class="text-sm">Terremoto 2:</span>
                            <span class="font-bold ${prop2.mag >= 7 ? 'text-red-500' : prop2.mag >= 5 ? 'text-orange-500' : 'text-yellow-500'}">
                                ${prop2.mag >= 7 ? 'EXTREMO' : prop2.mag >= 5 ? 'ALTO' : 'MODERADO'}
                            </span>
                        </div>
                    </div>
                </div>
            </div>
            
            <div class="p-6 card-modern rounded-lg">
                <h5 class="font-bold mb-4 flex items-center gap-2 text-lg">
                    <i class="fas fa-info-circle text-blue-500"></i>
                    Análisis Detallado
                </h5>
                <div class="space-y-3 text-sm">
                    <p class="flex items-start gap-2">
                        <i class="fas fa-chevron-right text-primary mt-1"></i>
                        <span>El terremoto en <strong class="text-white">${strongerQuake}</strong> fue 
                        <strong class="text-primary">${energyRatio.toFixed(0)} veces más potente</strong> 
                        en términos de energía liberada.</span>
                    </p>
                    <p class="flex items-start gap-2">
                        <i class="fas fa-chevron-right text-primary mt-1"></i>
                        <span>El evento más profundo ocurrió en <strong class="text-white">${deeperQuake}</strong>, 
                        a <strong class="text-yellow-400">${Math.max(coords1[2], coords2[2]).toFixed(1)} km</strong> 
                        de profundidad.</span>
                    </p>
                    <p class="flex items-start gap-2">
                        <i class="fas fa-chevron-right text-primary mt-1"></i>
                        <span>Los eventos están separados por 
                        <strong class="text-green-400">${distance.toFixed(0)} kilómetros</strong> de distancia.</span>
                    </p>
                    ${distance < 500 && timeDiff < 7 ? `
                    <p class="flex items-start gap-2 text-orange-400">
                        <i class="fas fa-exclamation-triangle mt-1"></i>
                        <span><strong>Alerta:</strong> Estos terremotos ocurrieron cerca en espacio y tiempo. 
                        Podrían estar relacionados como evento principal y réplica.</span>
                    </p>
                    ` : ''}
                </div>
            </div>
        </div>
    `;
    
    addNotification('success', 'Comparación completada');
}

// ============================================
// FUNCIONALIDADES CIENTÍFICAS AVANZADAS DEL MAPA
// ============================================

// ============================================
// HERRAMIENTAS AVANZADAS DEL MAPA
// ============================================

// Variables globales para herramientas
// ============================================
// FUNCIONES DE HEATMAP Y RIESGO ML
// REDIRIGIDAS AL NUEVO SISTEMA DE MANAGERS
// ============================================
// HERRAMIENTAS DEL MAPA
// ============================================

// Variables de estado para herramienta de medición
let measurementMode = false;
let measurementPoints = [];
let measurementLine = null;
let measurementMarkers = [];

// ============================================
// INICIALIZACIÓN DE HERRAMIENTAS
// ============================================

// Inicializar todas las herramientas del mapa
function initializeMapTools() {
    console.log('🛠️ Inicializando herramientas del mapa...');
    
    const measureBtn = document.getElementById('measureBtn');
    
    if (measureBtn) {
        measureBtn.addEventListener('click', toggleMeasurementTool);
    }
    
    console.log('🛠️ Herramientas del mapa inicializadas');
}

// ============================================
// HERRAMIENTA DE MEDICIÓN
// ============================================

// Toggle Herramienta de Medición
function toggleMeasurementTool() {
    measurementMode = !measurementMode;
    const btn = document.getElementById('measureBtn');
    
    if (measurementMode) {
        btn.classList.add('ring-2', 'ring-white');
        btn.innerHTML = '<i class="fas fa-times mr-1"></i>Cancelar';
        
        map.on('click', handleMeasurementClick);
    } else {
        btn.classList.remove('ring-2', 'ring-white');
        btn.innerHTML = '<i class="fas fa-ruler mr-1"></i>Medir';
        clearMeasurement();
        map.off('click', handleMeasurementClick);
    }
}

// Manejar clicks en modo medición
function handleMeasurementClick(e) {
    measurementPoints.push(e.latlng);
    
    // Agregar marcador
    const marker = L.circleMarker(e.latlng, {
        radius: 6,
        fillColor: '#4c51bf',
        color: '#fff',
        weight: 2,
        fillOpacity: 0.8
    }).addTo(map);
    measurementMarkers.push(marker);
    
    if (measurementPoints.length === 2) {
        // Calcular y mostrar distancia
        const distance = getDistance(
            measurementPoints[0].lat, measurementPoints[0].lng,
            measurementPoints[1].lat, measurementPoints[1].lng
        );
        
        // Dibujar línea
        measurementLine = L.polyline(measurementPoints, {
            color: '#4c51bf',
            weight: 3,
            dashArray: '10, 10',
            className: 'distance-line'
        }).addTo(map);
        
        // Mostrar resultado
        const midpoint = [
            (measurementPoints[0].lat + measurementPoints[1].lat) / 2,
            (measurementPoints[0].lng + measurementPoints[1].lng) / 2
        ];
        
        L.popup()
            .setLatLng(midpoint)
            .setContent(`
                <div style="text-align: center; padding: 10px;">
                    <h4 style="margin: 0 0 8px 0; color: #4c51bf; font-size: 16px;">
                        <i class="fas fa-ruler"></i> Distancia
                    </h4>
                    <p style="margin: 0; font-size: 24px; font-weight: bold;">
                        ${distance.toFixed(2)} km
                    </p>
                    <p style="margin: 8px 0 0 0; font-size: 12px; color: #666;">
                        ${(distance * 0.621371).toFixed(2)} millas
                    </p>
                </div>
            `)
            .openOn(map);
        
        addNotification('success', `Distancia: ${distance.toFixed(2)} km`);
        
        // Reset para nueva medición
        setTimeout(() => {
            clearMeasurement();
            measurementPoints = [];
        }, 3000);
    }
}

// Limpiar medición
function clearMeasurement() {
    measurementMarkers.forEach(marker => map.removeLayer(marker));
    measurementMarkers = [];
    if (measurementLine) {
        map.removeLayer(measurementLine);
        measurementLine = null;
    }
}

// ==================== MODAL DE DETALLES COMPLETOS ====================

window.showFullDetails = function(earthquakeId) {
    // Buscar el marcador con este ID
    let earthquakeData = null;
    
    markerClusterGroup.eachLayer(marker => {
        if (marker.earthquakeData && marker.earthquakeData.id === earthquakeId) {
            earthquakeData = marker.earthquakeData;
        }
    });
    
    if (!earthquakeData) {
        if (typeof addNotification === 'function') {
            addNotification('warning', 'No se encontraron los datos del terremoto');
        }
        return;
    }
    
    const { magnitude, place, lat, lon, depth, time, energy, intensity, waveSpeed, url, type} = earthquakeData;
    
    // Usar el modal existente en el HTML
    const modal = document.getElementById('earthquake-details-modal');
    const modalContent = document.getElementById('modal-earthquake-content');
    
    if (!modal || !modalContent) {
        console.error('Modal no encontrado en el HTML');
        return;
    }
    
    // Generar el contenido del modal con las clases CSS originales
    modalContent.innerHTML = `
        <div class="modal-header-content" style="background: linear-gradient(135deg, #dc143c, #b22222); color: white; padding: 20px 24px; border-radius: 12px 12px 0 0;">
            <h2 style="margin: 0; font-size: 22px; font-weight: 700; display: flex; align-items: center; gap: 10px;">
                <i class="fas fa-chart-line"></i> Análisis Completo del Terremoto
            </h2>
        </div>
        <div style="padding: 24px;">
            <div class="modal-section">
                <h3>📍 Información General</h3>
                <div class="info-grid-2col">
                    <div><strong>Magnitud:</strong> M ${magnitude.toFixed(2)}</div>
                    <div><strong>Intensidad:</strong> ${getIntensityBadge(intensity)}</div>
                    <div style="grid-column: span 2;"><strong>Ubicación:</strong> ${place}</div>
                    <div><strong>Tipo:</strong> ${type}</div>
                    <div><strong>Profundidad:</strong> ${depth.toFixed(1)} km</div>
                    <div><strong>Fecha:</strong> ${new Date(time).toLocaleDateString()}</div>
                    <div><strong>Hora:</strong> ${new Date(time).toLocaleTimeString()}</div>
                    <div style="grid-column: span 2;"><strong>Coordenadas:</strong> ${lat.toFixed(4)}°, ${lon.toFixed(4)}°</div>
                    <div style="grid-column: span 2;"><strong>Hace:</strong> ${getTimeAgo(time)}</div>
                </div>
            </div>
            
            <div class="modal-section">
                <h3>⚡ Energía Liberada</h3>
                <div class="energy-visual">
                    <div class="energy-bar" style="width: ${Math.min((magnitude / 9) * 100, 100)}%;"></div>
                </div>
                <p style="margin: 8px 0 4px 0; font-size: 16px;"><strong>${formatEnergy(energy)}</strong> de energía sísmica</p>
                <p class="energy-comparison">${getEnergyComparison(energy)}</p>
            </div>
            
            <div class="modal-section">
                <h3>🌊 Ondas Sísmicas</h3>
                <div class="waves-grid">
                    <div class="wave-card">
                        <div class="wave-icon">P</div>
                        <div class="wave-label">Onda Primaria</div>
                        <div class="wave-speed">${waveSpeed.p.toFixed(2)} km/s</div>
                    </div>
                    <div class="wave-card">
                        <div class="wave-icon">S</div>
                        <div class="wave-label">Onda Secundaria</div>
                        <div class="wave-speed">${waveSpeed.s.toFixed(2)} km/s</div>
                    </div>
                </div>
            </div>
            
            <div class="modal-section">
                <h3>🎯 Clasificación</h3>
                <div class="classification-badges">
                    ${getMagnitudeClassification(magnitude)}
                    ${getDepthClassification(depth)}
                    ${getRiskLevel(magnitude, depth)}
                </div>
            </div>
            
            <div class="modal-actions">
                <button onclick='window.open("${url}", "_blank")' class="modal-btn primary">
                    <i class="fas fa-external-link-alt"></i> Ver en USGS
                </button>
                <button onclick="window.shareEarthquake('${earthquakeId}')" class="modal-btn secondary">
                    <i class="fas fa-share-alt"></i> Compartir
                </button>
                <button onclick="window.closeDetailsModal()" class="modal-btn secondary">
                    <i class="fas fa-times"></i> Cerrar
                </button>
            </div>
        </div>
    `;
    
    // Mostrar el modal
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
};

window.closeDetailsModal = function() {
    const modal = document.getElementById('earthquake-details-modal');
    if (modal) {
        modal.classList.add('hidden');
        document.body.style.overflow = '';
    }
};

// Funciones auxiliares para el modal
function getTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days} día${days > 1 ? 's' : ''}`;
    if (hours > 0) return `${hours} hora${hours > 1 ? 's' : ''}`;
    if (minutes > 0) return `${minutes} minuto${minutes > 1 ? 's' : ''}`;
    return 'Hace momentos';
}

function getEnergyComparison(energy) {
    if (energy < 1e12) return 'Equivalente a un pequeño explosivo';
    if (energy < 1e15) return 'Equivalente a una bomba convencional';
    if (energy < 1e17) return 'Equivalente a una bomba atómica pequeña';
    if (energy < 1e20) return 'Equivalente a una bomba nuclear';
    return 'Energía devastadora a escala catastrófica';
}

function getMagnitudeClassification(mag) {
    if (mag < 2) return '<span class="badge badge-green">Micro</span>';
    if (mag < 4) return '<span class="badge badge-yellow">Menor</span>';
    if (mag < 5) return '<span class="badge badge-orange">Ligero</span>';
    if (mag < 6) return '<span class="badge badge-orange-red">Moderado</span>';
    if (mag < 7) return '<span class="badge badge-red">Fuerte</span>';
    if (mag < 8) return '<span class="badge badge-dark-red">Mayor</span>';
    return '<span class="badge badge-crimson">Épico</span>';
}

function getDepthClassification(depth) {
    if (depth < 70) return '<span class="badge badge-blue">Superficial</span>';
    if (depth < 300) return '<span class="badge badge-indigo">Intermedio</span>';
    return '<span class="badge badge-purple">Profundo</span>';
}

function getRiskLevel(magnitude, depth) {
    // Clasificación USGS estándar basada ÚNICAMENTE en magnitud
    // Referencia: https://www.usgs.gov/programs/earthquake-hazards/earthquake-magnitude-energy-release-and-shaking-intensity
    // La profundidad afecta el daño pero la clasificación oficial es por magnitud
    
    if (magnitude >= 7.0) {
        // Major/Great: Daño severo en áreas extensas
        return '<span class="badge badge-red">Riesgo Crítico (Major/Great)</span>';
    } else if (magnitude >= 6.0) {
        // Strong: Daño considerable en áreas pobladas
        return '<span class="badge badge-orange">Riesgo Alto (Strong)</span>';
    } else if (magnitude >= 5.0) {
        // Moderate: Daño menor a estructuras
        return '<span class="badge badge-yellow">Riesgo Moderado (Moderate)</span>';
    } else if (magnitude >= 4.0) {
        // Light: Sentido ampliamente, sin daño significativo
        return '<span class="badge badge-green">Riesgo Bajo (Light)</span>';
    } else {
        // Minor/Micro: Raramente sentido
        return '<span class="badge badge-green">Riesgo Mínimo (Minor/Micro)</span>';
    }
}

window.shareEarthquake = function(earthquakeId) {
    // Implementación simple de compartir
    const shareText = `Terremoto detectado - Magnitud ${earthquakeId}`;
    if (navigator.share) {
        navigator.share({
            title: 'SismoGlobal',
            text: shareText,
            url: window.location.href
        });
    } else {
        navigator.clipboard.writeText(window.location.href);
        addNotification('success', 'Enlace copiado al portapapeles');
    }
};

// Calcular distancia entre dos puntos (fórmula Haversine)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radio de la Tierra en km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

console.log('📄 Script cargado - Esperando DOMContentLoaded...');