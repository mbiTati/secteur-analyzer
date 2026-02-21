/**
 * Secteur Analyzer - Application d'analyse de secteur immobilier
 * Utilise les APIs publiques françaises : DVF, Geo API, INSEE
 */

// ============================================
// CONFIGURATION
// ============================================

const API_CONFIG = {
    geo: 'https://geo.api.gouv.fr',
    // APIs DVF - multiples sources pour fallback
    dvfApis: [
        // API cquest (la plus complète)
        {
            name: 'cquest',
            url: 'https://api.cquest.org/dvf',
            buildUrl: (code) => `https://api.cquest.org/dvf?code_commune=${code}`,
            needsCors: true,
            parser: 'cquest'
        },
        // API OpenDataSoft (backup fiable)
        {
            name: 'opendatasoft',
            url: 'https://data.opendatasoft.com/api/explore/v2.1/catalog/datasets/buildingref-france-demande-de-valeurs-foncieres-geolocalisee-millesime@public/records',
            buildUrl: (code) => `https://data.opendatasoft.com/api/explore/v2.1/catalog/datasets/buildingref-france-demande-de-valeurs-foncieres-geolocalisee-millesime@public/records?where=code_commune%3D%22${code}%22&limit=100&order_by=date_mutation%20desc`,
            needsCors: false,
            parser: 'opendatasoft'
        }
    ],
    // Proxies CORS (en ordre de fiabilité)
    corsProxies: [
        'https://api.allorigins.win/raw?url=',
        'https://corsproxy.io/?',
        'https://api.codetabs.com/v1/proxy?quest='
    ],
    meilleursAgents: 'https://www.meilleursagents.com/prix-immobilier/'
};

// État global de l'application
let currentData = {
    commune: null,
    dvfTransactions: [],
    stats: {},
    meilleursAgents: null
};

let priceChart = null;

// ============================================
// ÉLÉMENTS DOM
// ============================================

const elements = {
    cityInput: document.getElementById('cityInput'),
    searchBtn: document.getElementById('searchBtn'),
    suggestions: document.getElementById('suggestions'),
    errorMessage: document.getElementById('errorMessage'),
    results: document.getElementById('results'),
    loadingOverlay: document.getElementById('loadingOverlay'),
    loadingText: document.getElementById('loadingText'),
    loadingProgress: document.getElementById('loadingProgress'),
    exportBtn: document.getElementById('exportBtn')
};

// ============================================
// GESTION DES SUGGESTIONS DE COMMUNES
// ============================================

let searchTimeout = null;

elements.cityInput.addEventListener('input', (e) => {
    const query = e.target.value.trim();
    
    if (searchTimeout) clearTimeout(searchTimeout);
    
    if (query.length < 2) {
        elements.suggestions.classList.remove('active');
        return;
    }
    
    searchTimeout = setTimeout(() => {
        searchCommunes(query);
    }, 300);
});

elements.cityInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        elements.suggestions.classList.remove('active');
        startAnalysis();
    }
});

async function searchCommunes(query) {
    try {
        const response = await fetch(
            `${API_CONFIG.geo}/communes?nom=${encodeURIComponent(query)}&fields=nom,code,codesPostaux,population,departement&limit=8&boost=population`
        );
        
        if (!response.ok) throw new Error('Erreur API');
        
        const communes = await response.json();
        displaySuggestions(communes);
    } catch (error) {
        console.error('Erreur recherche communes:', error);
    }
}

function displaySuggestions(communes) {
    if (!communes.length) {
        elements.suggestions.classList.remove('active');
        return;
    }
    
    elements.suggestions.innerHTML = communes.map(c => `
        <div class="suggestion-item" data-code="${c.code}" data-name="${c.nom}">
            <div>
                <span class="name">${c.nom}</span>
                <span class="info">${c.codesPostaux?.[0] || ''} • ${c.departement?.nom || ''}</span>
            </div>
            <span class="info">${formatNumber(c.population)} hab.</span>
        </div>
    `).join('');
    
    elements.suggestions.classList.add('active');
    
    // Event listeners pour les suggestions
    elements.suggestions.querySelectorAll('.suggestion-item').forEach(item => {
        item.addEventListener('click', () => {
            elements.cityInput.value = item.dataset.name;
            elements.suggestions.classList.remove('active');
            startAnalysis(item.dataset.code);
        });
    });
}

// Fermer les suggestions au clic extérieur
document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
        elements.suggestions.classList.remove('active');
    }
});

// ============================================
// ANALYSE PRINCIPALE
// ============================================

elements.searchBtn.addEventListener('click', () => startAnalysis());

async function startAnalysis(codeInsee = null) {
    const query = elements.cityInput.value.trim();
    
    if (!query && !codeInsee) {
        showError('Veuillez entrer le nom d\'une commune');
        return;
    }
    
    hideError();
    showLoading();
    updateProgress(10, 'Recherche de la commune...');
    
    try {
        // Étape 1: Trouver la commune
        let commune;
        if (codeInsee) {
            commune = await getCommuneByCode(codeInsee);
        } else {
            commune = await getCommuneByName(query);
        }
        
        if (!commune) {
            throw new Error('Commune non trouvée');
        }
        
        currentData.commune = commune;
        updateProgress(30, 'Récupération des données DVF...');
        
        // Étape 2: Récupérer les transactions DVF
        const transactions = await getDVFTransactions(commune.code);
        currentData.dvfTransactions = transactions;
        updateProgress(60, 'Calcul des statistiques...');
        
        // Étape 3: Calculer les statistiques
        currentData.stats = calculateStats(transactions, commune);
        updateProgress(80, 'Récupération MeilleursAgents...');
        
        // Étape 4: Scraper MeilleursAgents (en parallèle, non bloquant)
        getMeilleursAgentsData(commune).then(maData => {
            currentData.meilleursAgents = maData;
            displayMeilleursAgents(maData, commune);
        }).catch(err => {
            console.warn('MeilleursAgents non disponible:', err);
            displayMeilleursAgentsError(commune);
        });
        
        updateProgress(90, 'Génération du rapport...');
        
        // Étape 5: Afficher les résultats
        await new Promise(resolve => setTimeout(resolve, 300));
        updateProgress(100, 'Terminé !');
        
        displayResults();
        
    } catch (error) {
        console.error('Erreur analyse:', error);
        showError(error.message || 'Une erreur est survenue lors de l\'analyse');
    } finally {
        hideLoading();
    }
}

// ============================================
// APPELS API
// ============================================

async function getCommuneByCode(code) {
    const response = await fetch(
        `${API_CONFIG.geo}/communes/${code}?fields=nom,code,codesPostaux,population,surface,departement,region`
    );
    if (!response.ok) throw new Error('Commune non trouvée');
    return response.json();
}

async function getCommuneByName(name) {
    const response = await fetch(
        `${API_CONFIG.geo}/communes?nom=${encodeURIComponent(name)}&fields=nom,code,codesPostaux,population,surface,departement,region&limit=1&boost=population`
    );
    if (!response.ok) throw new Error('Erreur recherche');
    const communes = await response.json();
    return communes[0] || null;
}

async function getDVFTransactions(codeInsee) {
    console.log('🔍 Recherche DVF pour code INSEE:', codeInsee);
    
    // Essayer chaque API DVF
    for (const api of API_CONFIG.dvfApis) {
        console.log(`📡 Tentative API ${api.name}...`);
        
        try {
            let response;
            const url = api.buildUrl(codeInsee);
            
            if (api.needsCors) {
                // Essayer avec chaque proxy CORS
                for (const proxy of API_CONFIG.corsProxies) {
                    try {
                        console.log(`  → Proxy: ${proxy.substring(0, 30)}...`);
                        response = await fetch(proxy + encodeURIComponent(url), {
                            signal: AbortSignal.timeout(15000)
                        });
                        if (response.ok) break;
                    } catch (e) {
                        console.warn(`  ✗ Proxy échoué:`, e.message);
                        continue;
                    }
                }
            } else {
                response = await fetch(url, {
                    signal: AbortSignal.timeout(15000)
                });
            }
            
            if (!response || !response.ok) {
                console.warn(`  ✗ API ${api.name} - pas de réponse valide`);
                continue;
            }
            
            const data = await response.json();
            let transactions = [];
            
            // Parser selon le type d'API
            if (api.parser === 'cquest') {
                if (data.resultats && Array.isArray(data.resultats)) {
                    transactions = data.resultats.map(normalizeTransactionCquest);
                    console.log(`  ✓ ${transactions.length} transactions via cquest`);
                }
            } else if (api.parser === 'opendatasoft') {
                if (data.results && Array.isArray(data.results)) {
                    transactions = data.results.map(normalizeTransactionODS);
                    console.log(`  ✓ ${transactions.length} transactions via OpenDataSoft`);
                }
            }
            
            if (transactions.length > 0) {
                return transactions;
            }
            
        } catch (e) {
            console.warn(`  ✗ Erreur API ${api.name}:`, e.message);
            continue;
        }
    }
    
    console.warn('⚠️ Aucune donnée DVF trouvée');
    return [];
}

// Normaliser les données des différentes APIs
function normalizeTransactionCquest(t) {
    return {
        date: t.date_mutation,
        type: normalizeType(t.type_local),
        adresse: t.adresse_nom_voie || t.adresse || 'Non renseignée',
        surface: parseFloat(t.surface_reelle_bati) || parseFloat(t.surface_terrain) || 0,
        prix: parseFloat(t.valeur_fonciere) || 0,
        prixM2: t.surface_reelle_bati > 0 ? Math.round(parseFloat(t.valeur_fonciere) / parseFloat(t.surface_reelle_bati)) : 0,
        pieces: parseInt(t.nombre_pieces_principales) || 0
    };
}

function normalizeTransactionODS(t) {
    // OpenDataSoft a une structure légèrement différente
    const surface = parseFloat(t.surface_reelle_bati) || parseFloat(t.surface_terrain) || 0;
    const prix = parseFloat(t.valeur_fonciere) || 0;
    return {
        date: t.date_mutation,
        type: normalizeType(t.type_local),
        adresse: t.adresse_nom_voie || 'Non renseignée',
        surface: surface,
        prix: prix,
        prixM2: surface > 0 ? Math.round(prix / surface) : 0,
        pieces: parseInt(t.nombre_pieces_principales) || 0
    };
}

function normalizeTransactionCerema(t) {
    const surface = parseFloat(t.sbati) || parseFloat(t.sterr) || 0;
    const prix = parseFloat(t.valeur_fonciere) || 0;
    return {
        date: t.date_mutation,
        type: normalizeType(t.libtypbien || t.type_local),
        adresse: t.l_adresse?.join(', ') || 'Non renseignée',
        surface: surface,
        prix: prix,
        prixM2: surface > 0 ? Math.round(prix / surface) : 0,
        pieces: parseInt(t.nbpprinc) || 0
    };
}

function normalizeType(type) {
    if (!type) return 'Autre';
    const t = type.toLowerCase();
    if (t.includes('maison')) return 'Maison';
    if (t.includes('appartement')) return 'Appartement';
    if (t.includes('terrain') || t.includes('dépendance')) return 'Terrain';
    if (t.includes('local') || t.includes('commerce')) return 'Commerce';
    return 'Autre';
}

// ============================================
// SCRAPING MEILLEURSAGENTS
// ============================================

async function getMeilleursAgentsData(commune) {
    // Construire l'URL MeilleursAgents
    const citySlug = normalizeForUrl(commune.nom);
    const codePostal = commune.codesPostaux?.[0] || '';
    const maUrl = `${API_CONFIG.meilleursAgents}${citySlug}-${codePostal}/`;
    
    console.log('🔍 Tentative MeilleursAgents:', maUrl);
    
    // Essayer chaque proxy CORS
    for (const proxy of API_CONFIG.corsProxies) {
        try {
            const response = await fetch(proxy + encodeURIComponent(maUrl), {
                headers: {
                    'Accept': 'text/html',
                },
                timeout: 10000
            });
            
            if (!response.ok) continue;
            
            const html = await response.text();
            const data = parseMeilleursAgentsHTML(html);
            
            if (data && (data.appartement || data.maison)) {
                data.url = maUrl;
                console.log('✅ MeilleursAgents récupéré via', proxy);
                return data;
            }
        } catch (e) {
            console.warn('Proxy failed:', proxy, e.message);
            continue;
        }
    }
    
    throw new Error('Tous les proxies ont échoué');
}

function normalizeForUrl(str) {
    return str
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // Enlever les accents
        .replace(/[^a-z0-9]+/g, '-')     // Remplacer les caractères spéciaux par des tirets
        .replace(/^-+|-+$/g, '');        // Enlever les tirets en début/fin
}

function parseMeilleursAgentsHTML(html) {
    const data = {
        appartement: null,
        maison: null,
        loyer: null,
        evolution: null
    };
    
    try {
        // Parser le HTML
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        
        // Méthode 1: Chercher les prix dans le texte de la page
        const text = doc.body?.innerText || html;
        
        // Pattern pour les prix appartements
        const apptMatch = text.match(/appartements[^€]*?(\d[\d\s]*)\s*€[^€]*?m²/i) 
            || text.match(/prix\s+m²\s+moyen\s+des\s+appartements[^€]*?(\d[\d\s]*)\s*€/i)
            || text.match(/appartement[^€]*?(\d[\d\s]*)\s*€\s*(?:\/\s*)?m²/i);
        
        // Pattern pour les prix maisons
        const maisonMatch = text.match(/maisons[^€]*?(\d[\d\s]*)\s*€[^€]*?m²/i)
            || text.match(/prix\s+(?:du\s+)?m²\s+(?:pour\s+les\s+)?maisons[^€]*?(\d[\d\s]*)\s*€/i)
            || text.match(/maison[^€]*?(\d[\d\s]*)\s*€\s*(?:\/\s*)?m²/i);
        
        // Pattern pour les fourchettes de prix
        const apptRangeMatch = text.match(/appartement[^€]*?entre\s*(\d[\d\s]*)\s*€\s*et\s*(\d[\d\s]*)\s*€/i)
            || text.match(/appartement[^€]*?(\d[\d\s]*)\s*€[^€]*?(\d[\d\s]*)\s*€/i);
        
        const maisonRangeMatch = text.match(/maison[^€]*?entre\s*(\d[\d\s]*)\s*€\s*et\s*(\d[\d\s]*)\s*€/i)
            || text.match(/maison[^€]*?(\d[\d\s]*)\s*€[^€]*?(\d[\d\s]*)\s*€/i);
        
        // Pattern pour les loyers
        const loyerApptMatch = text.match(/loyer[^€]*?appartement[^€]*?(\d+(?:[.,]\d+)?)\s*€\s*(?:\/\s*)?m²/i)
            || text.match(/appartement[^€]*?loyer[^€]*?(\d+(?:[.,]\d+)?)\s*€/i);
        
        const loyerMaisonMatch = text.match(/loyer[^€]*?maison[^€]*?(\d+(?:[.,]\d+)?)\s*€\s*(?:\/\s*)?m²/i)
            || text.match(/maison[^€]*?loyer[^€]*?(\d+(?:[.,]\d+)?)\s*€/i);
        
        // Extraire les valeurs
        if (apptMatch) {
            data.appartement = {
                prix: parsePrice(apptMatch[1]),
                min: apptRangeMatch ? parsePrice(apptRangeMatch[1]) : null,
                max: apptRangeMatch ? parsePrice(apptRangeMatch[2]) : null
            };
        }
        
        if (maisonMatch) {
            data.maison = {
                prix: parsePrice(maisonMatch[1]),
                min: maisonRangeMatch ? parsePrice(maisonRangeMatch[1]) : null,
                max: maisonRangeMatch ? parsePrice(maisonRangeMatch[2]) : null
            };
        }
        
        // Loyers
        if (loyerApptMatch || loyerMaisonMatch) {
            data.loyer = {
                appartement: loyerApptMatch ? parseFloat(loyerApptMatch[1].replace(',', '.')) : null,
                maison: loyerMaisonMatch ? parseFloat(loyerMaisonMatch[1].replace(',', '.')) : null
            };
        }
        
        // Méthode 2: Chercher dans les balises meta ou JSON-LD
        const scripts = doc.querySelectorAll('script[type="application/ld+json"]');
        scripts.forEach(script => {
            try {
                const jsonData = JSON.parse(script.textContent);
                // Extraire les données si disponibles
                if (jsonData['@type'] === 'Product' || jsonData.offers) {
                    // Traiter les données structurées
                }
            } catch (e) {}
        });
        
        console.log('📊 Données MeilleursAgents parsées:', data);
        
    } catch (e) {
        console.error('Erreur parsing MeilleursAgents:', e);
    }
    
    return data;
}

function parsePrice(str) {
    if (!str) return null;
    return parseInt(str.replace(/\s/g, ''), 10);
}

function displayMeilleursAgents(data, commune) {
    const container = document.querySelector('#meilleursAgentsData .ma-content');
    
    if (!data || (!data.appartement && !data.maison)) {
        displayMeilleursAgentsError(commune);
        return;
    }
    
    let html = '<div class="ma-prices-grid">';
    
    if (data.appartement) {
        html += `
            <div class="ma-price-card">
                <div class="type">Appartement</div>
                <div class="price">${formatNumber(data.appartement.prix)} €/m²</div>
                ${data.appartement.min && data.appartement.max ? 
                    `<div class="range">${formatNumber(data.appartement.min)} € → ${formatNumber(data.appartement.max)} €</div>` : ''}
            </div>
        `;
    }
    
    if (data.maison) {
        html += `
            <div class="ma-price-card">
                <div class="type">Maison</div>
                <div class="price">${formatNumber(data.maison.prix)} €/m²</div>
                ${data.maison.min && data.maison.max ? 
                    `<div class="range">${formatNumber(data.maison.min)} € → ${formatNumber(data.maison.max)} €</div>` : ''}
            </div>
        `;
    }
    
    html += '</div>';
    
    // Loyers si disponibles
    if (data.loyer && (data.loyer.appartement || data.loyer.maison)) {
        html += `
            <div class="ma-loyer">
                <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 8px;">Loyers estimés</div>
                <div class="ma-loyer-grid">
                    ${data.loyer.appartement ? `
                        <div class="ma-loyer-item">
                            <div class="label">Appartement</div>
                            <div class="value">${data.loyer.appartement} €/m²</div>
                        </div>
                    ` : ''}
                    ${data.loyer.maison ? `
                        <div class="ma-loyer-item">
                            <div class="label">Maison</div>
                            <div class="value">${data.loyer.maison} €/m²</div>
                        </div>
                    ` : ''}
                </div>
            </div>
        `;
    }
    
    // Lien vers MeilleursAgents
    if (data.url) {
        html += `
            <a href="${data.url}" target="_blank" class="ma-link">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Voir sur MeilleursAgents
            </a>
        `;
    }
    
    container.innerHTML = html;
    document.querySelector('#meilleursAgentsData .ma-loading').style.display = 'none';
}

function displayMeilleursAgentsError(commune) {
    const container = document.querySelector('#meilleursAgentsData .ma-content');
    const citySlug = normalizeForUrl(commune.nom);
    const codePostal = commune.codesPostaux?.[0] || '';
    const maUrl = `${API_CONFIG.meilleursAgents}${citySlug}-${codePostal}/`;
    
    container.innerHTML = `
        <div class="ma-error">
            <p>Données non disponibles automatiquement.</p>
            <a href="${maUrl}" target="_blank" class="ma-link" style="display: inline-flex; margin-top: 12px;">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Consulter MeilleursAgents manuellement
            </a>
        </div>
    `;
    document.querySelector('#meilleursAgentsData .ma-loading').style.display = 'none';
}

// ============================================
// CALCUL DES STATISTIQUES
// ============================================

function calculateStats(transactions, commune) {
    const validTransactions = transactions.filter(t => t.prix > 0 && t.surface > 0);
    
    // Grouper par type
    const byType = {};
    validTransactions.forEach(t => {
        if (!byType[t.type]) byType[t.type] = [];
        byType[t.type].push(t);
    });
    
    // Calculer stats par type
    const priceStats = {};
    Object.entries(byType).forEach(([type, trans]) => {
        const prices = trans.map(t => t.prixM2).filter(p => p > 0);
        if (prices.length > 0) {
            priceStats[type] = {
                count: trans.length,
                min: Math.min(...prices),
                max: Math.max(...prices),
                avg: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
                median: median(prices)
            };
        }
    });
    
    // Grouper par année pour le graphique
    const byYear = {};
    validTransactions.forEach(t => {
        const year = new Date(t.date).getFullYear();
        if (!byYear[year]) byYear[year] = [];
        byYear[year].push(t);
    });
    
    const yearlyStats = Object.entries(byYear)
        .map(([year, trans]) => ({
            year: parseInt(year),
            count: trans.length,
            avgPrice: Math.round(trans.reduce((a, t) => a + t.prixM2, 0) / trans.length)
        }))
        .sort((a, b) => a.year - b.year);
    
    // Répartition logements (simulation basée sur les transactions)
    const housingDist = calculateHousingDistribution(validTransactions);
    
    return {
        totalTransactions: transactions.length,
        validTransactions: validTransactions.length,
        priceStats,
        yearlyStats,
        housingDist,
        population: commune.population,
        surface: commune.surface,
        density: commune.surface > 0 ? Math.round(commune.population / (commune.surface / 100)) : 0
    };
}

function calculateHousingDistribution(transactions) {
    // Simuler une répartition basée sur les surfaces
    const surfaces = {
        'Moins de 30m²': 0,
        '30 à 60m²': 0,
        '60 à 80m²': 0,
        '80 à 100m²': 0,
        '100 à 120m²': 0,
        'Plus de 120m²': 0
    };
    
    transactions.forEach(t => {
        const s = t.surface;
        if (s < 30) surfaces['Moins de 30m²']++;
        else if (s < 60) surfaces['30 à 60m²']++;
        else if (s < 80) surfaces['60 à 80m²']++;
        else if (s < 100) surfaces['80 à 100m²']++;
        else if (s < 120) surfaces['100 à 120m²']++;
        else surfaces['Plus de 120m²']++;
    });
    
    const total = transactions.length || 1;
    return Object.entries(surfaces).map(([label, count]) => ({
        label,
        count,
        percent: Math.round((count / total) * 100)
    }));
}

function median(arr) {
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// ============================================
// AFFICHAGE DES RÉSULTATS
// ============================================

function displayResults() {
    const { commune, stats, dvfTransactions } = currentData;
    
    // Reset MeilleursAgents
    document.querySelector('#meilleursAgentsData .ma-loading').style.display = 'block';
    document.querySelector('#meilleursAgentsData .ma-content').innerHTML = '';
    
    // Header
    document.getElementById('cityName').textContent = commune.nom;
    document.getElementById('cityDept').innerHTML = `📍 ${commune.departement?.nom || ''} (${commune.departement?.code || ''})`;
    document.getElementById('cityPop').innerHTML = `👥 ${formatNumber(commune.population)} habitants`;
    document.getElementById('cityCode').innerHTML = `🏛️ INSEE: ${commune.code}`;
    
    // Stats principales
    displayMainStats(stats);
    
    // Prix par type
    displayPriceTable(stats.priceStats);
    
    // Démographie
    displayDemographics(stats, commune);
    
    // Répartition logements
    displayHousingBars(stats.housingDist);
    
    // Graphique évolution
    displayPriceChart(stats.yearlyStats);
    
    // Transactions
    displayTransactions(dvfTransactions);
    
    // Afficher la section résultats
    elements.results.classList.add('active');
    elements.results.scrollIntoView({ behavior: 'smooth' });
}

function displayMainStats(stats) {
    const avgPrice = Object.values(stats.priceStats)[0]?.avg || 0;
    const evolution = stats.yearlyStats.length >= 2 
        ? calculateEvolution(stats.yearlyStats)
        : null;
    
    const statsHtml = `
        <div class="stat-card">
            <div class="stat-label">Prix moyen au m²</div>
            <div class="stat-value accent">${formatNumber(avgPrice)} €</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Transactions DVF</div>
            <div class="stat-value">${formatNumber(stats.totalTransactions)}</div>
            <div class="stat-change">sur 5 ans</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Population</div>
            <div class="stat-value">${formatNumber(stats.population)}</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Densité</div>
            <div class="stat-value">${formatNumber(stats.density)}</div>
            <div class="stat-change">hab/km²</div>
        </div>
        ${evolution !== null ? `
        <div class="stat-card">
            <div class="stat-label">Évolution prix</div>
            <div class="stat-value ${evolution >= 0 ? 'positive' : 'negative'}">${evolution >= 0 ? '+' : ''}${evolution}%</div>
            <div class="stat-change">sur la période</div>
        </div>
        ` : ''}
    `;
    
    document.getElementById('statsGrid').innerHTML = statsHtml;
}

function calculateEvolution(yearlyStats) {
    if (yearlyStats.length < 2) return null;
    const first = yearlyStats[0].avgPrice;
    const last = yearlyStats[yearlyStats.length - 1].avgPrice;
    if (first === 0) return null;
    return Math.round(((last - first) / first) * 100);
}

function displayPriceTable(priceStats) {
    const types = ['Appartement', 'Maison', 'Terrain', 'Commerce'];
    const hasData = Object.keys(priceStats).length > 0;
    
    if (!hasData) {
        document.getElementById('priceTable').innerHTML = `
            <div style="text-align: center; padding: 20px; color: var(--text-muted);">
                <p>Données DVF non disponibles</p>
                <a href="https://app.dvf.etalab.gouv.fr/" target="_blank" style="color: var(--accent); font-size: 13px;">
                    Consulter DVF Etalab →
                </a>
            </div>
        `;
        return;
    }
    
    const html = types.map(type => {
        const data = priceStats[type];
        if (!data) return `
            <div class="price-row">
                <span class="price-label">${type}</span>
                <span class="price-value" style="color: var(--text-muted)">Pas de données</span>
            </div>
        `;
        
        return `
            <div class="price-row">
                <span class="price-label">${type}</span>
                <div>
                    <span class="price-value">${formatNumber(data.avg)} €/m²</span>
                    <div class="price-range">
                        <span>${formatNumber(data.min)} €</span>
                        <span>→</span>
                        <span>${formatNumber(data.max)} €</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
    
    document.getElementById('priceTable').innerHTML = html;
}

function displayDemographics(stats, commune) {
    const html = `
        <div class="demo-item">
            <div class="label">Population</div>
            <div class="value">${formatNumber(commune.population)}</div>
        </div>
        <div class="demo-item">
            <div class="label">Superficie</div>
            <div class="value">${(commune.surface / 100).toFixed(1)} km²</div>
        </div>
        <div class="demo-item">
            <div class="label">Densité</div>
            <div class="value">${formatNumber(stats.density)} hab/km²</div>
        </div>
        <div class="demo-item">
            <div class="label">Codes postaux</div>
            <div class="value" style="font-size: 16px;">${commune.codesPostaux?.join(', ') || '-'}</div>
        </div>
    `;
    
    document.getElementById('demoGrid').innerHTML = html;
}

function displayHousingBars(housingDist) {
    const maxPercent = Math.max(...housingDist.map(h => h.percent), 1);
    
    const html = housingDist.map(h => `
        <div class="housing-bar-item">
            <span class="housing-bar-label">${h.label}</span>
            <div class="housing-bar-track">
                <div class="housing-bar-fill" style="width: ${(h.percent / maxPercent) * 100}%"></div>
            </div>
            <span class="housing-bar-value">${h.percent}%</span>
        </div>
    `).join('');
    
    document.getElementById('housingBars').innerHTML = html;
}

function displayPriceChart(yearlyStats) {
    const ctx = document.getElementById('priceChart').getContext('2d');
    
    // Détruire le graphique existant
    if (priceChart) {
        priceChart.destroy();
    }
    
    if (yearlyStats.length === 0) {
        ctx.font = '14px DM Sans';
        ctx.fillStyle = '#71717a';
        ctx.textAlign = 'center';
        ctx.fillText('Pas assez de données pour afficher le graphique', ctx.canvas.width / 2, ctx.canvas.height / 2);
        return;
    }
    
    priceChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: yearlyStats.map(s => s.year),
            datasets: [
                {
                    label: 'Prix moyen €/m²',
                    data: yearlyStats.map(s => s.avgPrice),
                    borderColor: '#f59e0b',
                    backgroundColor: 'rgba(245, 158, 11, 0.1)',
                    fill: true,
                    tension: 0.4,
                    pointRadius: 4,
                    pointBackgroundColor: '#f59e0b'
                },
                {
                    label: 'Nb transactions',
                    data: yearlyStats.map(s => s.count),
                    borderColor: '#71717a',
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0.4,
                    pointRadius: 3,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        color: '#a1a1aa',
                        font: { family: 'DM Sans' }
                    }
                }
            },
            scales: {
                x: {
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { color: '#71717a' }
                },
                y: {
                    position: 'left',
                    grid: { color: 'rgba(255,255,255,0.05)' },
                    ticks: { 
                        color: '#f59e0b',
                        callback: v => formatNumber(v) + ' €'
                    }
                },
                y1: {
                    position: 'right',
                    grid: { display: false },
                    ticks: { color: '#71717a' }
                }
            }
        }
    });
}

function displayTransactions(transactions) {
    const recent = transactions
        .filter(t => t.prix > 0)
        .sort((a, b) => new Date(b.date) - new Date(a.date))
        .slice(0, 50);
    
    document.getElementById('transactionCount').textContent = 
        `${recent.length} sur ${transactions.length} transactions`;
    
    const html = recent.map(t => `
        <tr>
            <td>${formatDate(t.date)}</td>
            <td><span class="type-badge ${t.type.toLowerCase()}">${t.type}</span></td>
            <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${t.adresse}</td>
            <td>${t.surface > 0 ? t.surface + ' m²' : '-'}</td>
            <td style="font-weight: 600;">${formatNumber(t.prix)} €</td>
            <td style="color: var(--accent);">${t.prixM2 > 0 ? formatNumber(t.prixM2) + ' €' : '-'}</td>
        </tr>
    `).join('');
    
    document.getElementById('transactionsBody').innerHTML = html || `
        <tr>
            <td colspan="6" style="text-align: center; padding: 40px 20px;">
                <div style="color: var(--text-muted);">
                    <svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" fill="none" viewBox="0 0 24 24" stroke="currentColor" style="margin-bottom: 12px; opacity: 0.5;">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p style="margin-bottom: 8px;">Aucune transaction DVF disponible</p>
                    <p style="font-size: 12px; opacity: 0.7;">Les APIs DVF peuvent être temporairement indisponibles.<br>Vous pouvez consulter directement <a href="https://app.dvf.etalab.gouv.fr/" target="_blank" style="color: var(--accent);">app.dvf.etalab.gouv.fr</a></p>
                </div>
            </td>
        </tr>
    `;
}

// ============================================
// EXPORT EXCEL
// ============================================

elements.exportBtn.addEventListener('click', exportToExcel);

function exportToExcel() {
    const { commune, stats, dvfTransactions, meilleursAgents } = currentData;
    
    if (!commune) {
        showError('Aucune donnée à exporter');
        return;
    }
    
    const wb = XLSX.utils.book_new();
    
    // Feuille 1: Synthèse
    const syntheseData = [
        ['ANALYSE DE SECTEUR - ' + commune.nom.toUpperCase()],
        ['Généré le ' + new Date().toLocaleDateString('fr-FR')],
        [''],
        ['INFORMATIONS GÉNÉRALES'],
        ['Commune', commune.nom],
        ['Code INSEE', commune.code],
        ['Département', commune.departement?.nom || ''],
        ['Code postal', commune.codesPostaux?.join(', ') || ''],
        ['Population', commune.population],
        ['Superficie (km²)', (commune.surface / 100).toFixed(2)],
        ['Densité (hab/km²)', stats.density],
        [''],
        ['PRIX AU M² (DVF - Transactions réelles)'],
    ];
    
    Object.entries(stats.priceStats).forEach(([type, data]) => {
        syntheseData.push([type, '', 'Moyen', data.avg + ' €', 'Min', data.min + ' €', 'Max', data.max + ' €', 'Nb', data.count]);
    });
    
    // Ajouter données MeilleursAgents si disponibles
    if (meilleursAgents && (meilleursAgents.appartement || meilleursAgents.maison)) {
        syntheseData.push(['']);
        syntheseData.push(['ESTIMATIONS MEILLEURSAGENTS']);
        if (meilleursAgents.appartement) {
            syntheseData.push(['Appartement', meilleursAgents.appartement.prix + ' €/m²', 
                'Min', (meilleursAgents.appartement.min || '-') + ' €', 
                'Max', (meilleursAgents.appartement.max || '-') + ' €']);
        }
        if (meilleursAgents.maison) {
            syntheseData.push(['Maison', meilleursAgents.maison.prix + ' €/m²',
                'Min', (meilleursAgents.maison.min || '-') + ' €', 
                'Max', (meilleursAgents.maison.max || '-') + ' €']);
        }
        if (meilleursAgents.loyer) {
            syntheseData.push(['']);
            syntheseData.push(['LOYERS ESTIMÉS']);
            if (meilleursAgents.loyer.appartement) {
                syntheseData.push(['Loyer Appartement', meilleursAgents.loyer.appartement + ' €/m²']);
            }
            if (meilleursAgents.loyer.maison) {
                syntheseData.push(['Loyer Maison', meilleursAgents.loyer.maison + ' €/m²']);
            }
        }
    }
    
    const wsSynthese = XLSX.utils.aoa_to_sheet(syntheseData);
    XLSX.utils.book_append_sheet(wb, wsSynthese, 'Synthèse');
    
    // Feuille 2: Transactions DVF
    const transHeaders = ['Date', 'Type', 'Adresse', 'Surface (m²)', 'Prix (€)', 'Prix/m² (€)', 'Nb pièces'];
    const transData = [transHeaders, ...dvfTransactions.map(t => [
        t.date,
        t.type,
        t.adresse,
        t.surface,
        t.prix,
        t.prixM2,
        t.pieces
    ])];
    
    const wsDVF = XLSX.utils.aoa_to_sheet(transData);
    XLSX.utils.book_append_sheet(wb, wsDVF, 'Transactions DVF');
    
    // Feuille 3: Évolution annuelle
    const evolHeaders = ['Année', 'Nb transactions', 'Prix moyen €/m²'];
    const evolData = [evolHeaders, ...stats.yearlyStats.map(s => [s.year, s.count, s.avgPrice])];
    
    const wsEvol = XLSX.utils.aoa_to_sheet(evolData);
    XLSX.utils.book_append_sheet(wb, wsEvol, 'Évolution');
    
    // Feuille 4: Répartition surfaces
    const distHeaders = ['Tranche de surface', 'Nombre', 'Pourcentage'];
    const distData = [distHeaders, ...stats.housingDist.map(h => [h.label, h.count, h.percent + '%'])];
    
    const wsDist = XLSX.utils.aoa_to_sheet(distData);
    XLSX.utils.book_append_sheet(wb, wsDist, 'Répartition surfaces');
    
    // Télécharger
    const filename = `Analyse_Secteur_${commune.nom.replace(/\s+/g, '_')}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    XLSX.writeFile(wb, filename);
}

// ============================================
// UTILITAIRES
// ============================================

function formatNumber(num) {
    if (num === undefined || num === null) return '-';
    return new Intl.NumberFormat('fr-FR').format(num);
}

function formatDate(dateStr) {
    if (!dateStr) return '-';
    const date = new Date(dateStr);
    return date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function showLoading() {
    elements.loadingOverlay.classList.add('active');
    elements.searchBtn.disabled = true;
    elements.searchBtn.innerHTML = '<div class="spinner"></div><span>Analyse...</span>';
}

function hideLoading() {
    elements.loadingOverlay.classList.remove('active');
    elements.searchBtn.disabled = false;
    elements.searchBtn.innerHTML = '<span>Analyser</span>';
}

function updateProgress(percent, text) {
    elements.loadingProgress.style.width = percent + '%';
    elements.loadingText.textContent = text;
}

function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorMessage.classList.add('active');
}

function hideError() {
    elements.errorMessage.classList.remove('active');
}

// ============================================
// INITIALISATION
// ============================================

// Focus sur l'input au chargement
elements.cityInput.focus();

console.log('🏠 Secteur Analyzer chargé');
