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
        // API Etalab officielle (la plus fiable, mais nécessite section cadastrale)
        {
            name: 'etalab',
            buildUrl: (code) => `https://app.dvf.etalab.gouv.fr/api/mutations3/${code}`,
            needsCors: false,
            parser: 'etalab'
        },
        // API cquest (complète, par code commune)
        {
            name: 'cquest',
            buildUrl: (code) => `https://api.cquest.org/dvf?code_commune=${code}`,
            needsCors: true,
            parser: 'cquest'
        },
        // API OpenDataSoft (backup fiable)
        {
            name: 'opendatasoft',
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
    // URLs des sources pour liens manuels
    sources: {
        dvfEtalab: {
            name: 'DVF Etalab',
            baseUrl: 'https://app.dvf.etalab.gouv.fr/',
            buildUrl: (deptCode) => `https://app.dvf.etalab.gouv.fr/?code_departement=${deptCode}`,
            github: 'https://github.com/etalab/DVF-app'
        },
        meilleursAgents: {
            name: 'MeilleursAgents',
            baseUrl: 'https://www.meilleursagents.com/prix-immobilier/',
            buildUrl: (nom, cp) => {
                const slug = nom.toLowerCase()
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, '');
                return `https://www.meilleursagents.com/prix-immobilier/${slug}-${cp}/`;
            }
        },
        linternaute: {
            name: "L'Internaute",
            baseUrl: 'https://www.linternaute.com/ville/',
            buildUrl: (nom, code) => {
                const slug = nom.toLowerCase()
                    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                    .replace(/[^a-z0-9]+/g, '-')
                    .replace(/^-|-$/g, '');
                return `https://www.linternaute.com/ville/${slug}/ville-${code}/immobilier`;
            }
        },
        insee: {
            name: 'INSEE',
            baseUrl: 'https://www.insee.fr/fr/statistiques/zones/2011101',
            buildUrl: (code) => `https://www.insee.fr/fr/statistiques/2011101?geo=COM-${code}`
        },
        dataGouv: {
            name: 'Data.gouv.fr',
            baseUrl: 'https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres/',
            buildUrl: () => 'https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres/'
        }
    },
    meilleursAgents: 'https://www.meilleursagents.com/prix-immobilier/',
    // L'Internaute pour données INSEE détaillées
    linternaute: {
        baseUrl: 'https://www.linternaute.com/ville/',
        // URL pattern: /ville/{nom-commune}/ville-{code}/immobilier
        buildUrl: (nom, code) => {
            const slug = nom.toLowerCase()
                .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '');
            return `https://www.linternaute.com/ville/${slug}/ville-${code}/immobilier`;
        }
    }
};

// État global de l'application
let currentData = {
    commune: null,
    dvfTransactions: [],
    stats: {},
    meilleursAgents: null,
    linternaute: null
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
        
        // Étape 4b: Scraper L'Internaute pour données INSEE (en parallèle, non bloquant)
        getLInternauteData(commune).then(liData => {
            currentData.linternaute = liData;
            displayLInternauteData(liData);
        }).catch(err => {
            console.warn("L'Internaute non disponible:", err);
            // Afficher lien manuel
            displayLInternauteError(commune);
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
            if (api.parser === 'etalab') {
                // L'API Etalab retourne { mutations: [...] }
                if (data.mutations && Array.isArray(data.mutations)) {
                    transactions = data.mutations.map(normalizeTransactionEtalab);
                    console.log(`  ✓ ${transactions.length} transactions via Etalab`);
                }
            } else if (api.parser === 'cquest') {
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

// Normaliser les données de l'API Etalab
function normalizeTransactionEtalab(t) {
    const surface = parseFloat(t.surface_reelle_bati) || parseFloat(t.surface_terrain) || 0;
    const prix = parseFloat(t.valeur_fonciere) || 0;
    return {
        date: t.date_mutation,
        type: normalizeType(t.type_local),
        adresse: t.adresse_nom_voie || 'Non renseignée',
        surface: surface,
        prix: prix,
        prixM2: surface > 0 ? Math.round(prix / surface) : 0,
        pieces: parseInt(t.nombre_pieces_principales) || 0,
        codePostal: t.code_postal,
        idMutation: t.id_mutation
    };
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
// SCRAPING L'INTERNAUTE (INSEE)
// ============================================

async function getLInternauteData(commune) {
    console.log("🏠 Récupération données L'Internaute pour:", commune.nom);
    
    const url = API_CONFIG.linternaute.buildUrl(commune.nom, commune.code);
    console.log("📍 URL L'Internaute:", url);
    
    // Essayer chaque proxy CORS
    for (const proxy of API_CONFIG.corsProxies) {
        try {
            console.log(`  → Essai proxy: ${proxy.substring(0, 30)}...`);
            
            const response = await fetch(proxy + encodeURIComponent(url), {
                signal: AbortSignal.timeout(15000),
                headers: {
                    'Accept': 'text/html'
                }
            });
            
            if (!response.ok) continue;
            
            const html = await response.text();
            
            // Vérifier que c'est bien du HTML de L'Internaute
            if (!html.includes('linternaute') && !html.includes('logement') && !html.includes('immobilier')) {
                console.warn('  ✗ Contenu HTML non valide');
                continue;
            }
            
            const data = parseLInternauteHTML(html);
            
            if (data && (data.nbLogements || data.repartitionPieces || data.typesLogements)) {
                data.url = url;
                console.log("✓ Données L'Internaute récupérées:", data);
                return data;
            }
            
        } catch (e) {
            console.warn(`  ✗ Proxy échoué:`, e.message);
            continue;
        }
    }
    
    console.warn("⚠️ L'Internaute non accessible via les proxies");
    throw new Error("Données L'Internaute non disponibles");
}

function parseLInternauteHTML(html) {
    const data = {
        nbLogements: null,
        residencesPrincipales: null,
        residencesSecondaires: null,
        logementsVacants: null,
        typesLogements: null,  // Maisons vs Appartements
        repartitionPieces: null,  // T1, T2, T3, etc.
        proprietaires: null,
        locataires: null,
        anneeConstruction: null
    };
    
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(html, 'text/html');
        const text = doc.body?.innerText || html;
        
        // Nombre total de logements
        const nbLogMatch = text.match(/(\d[\d\s]*)\s*logements?\s*(?:au total|en\s*\d{4}|dans)/i)
            || text.match(/nombre\s*(?:de\s*)?logements?\s*[:\s]*(\d[\d\s]*)/i)
            || text.match(/parc\s*(?:de\s*)?logements?\s*[:\s]*(\d[\d\s]*)/i);
        if (nbLogMatch) {
            data.nbLogements = parseInt(nbLogMatch[1].replace(/\s/g, ''), 10);
        }
        
        // Résidences principales
        const rpMatch = text.match(/(\d[\d\s,]*)\s*résidences?\s*principales?/i)
            || text.match(/résidences?\s*principales?\s*[:\s]*(\d[\d\s,]*)/i);
        if (rpMatch) {
            data.residencesPrincipales = parseInt(rpMatch[1].replace(/[\s,]/g, ''), 10);
        }
        
        // Résidences secondaires
        const rsMatch = text.match(/(\d[\d\s,]*)\s*résidences?\s*secondaires?/i)
            || text.match(/résidences?\s*secondaires?\s*[:\s]*(\d[\d\s,]*)/i);
        if (rsMatch) {
            data.residencesSecondaires = parseInt(rsMatch[1].replace(/[\s,]/g, ''), 10);
        }
        
        // Logements vacants
        const lvMatch = text.match(/(\d[\d\s,]*)\s*logements?\s*vacants?/i)
            || text.match(/logements?\s*vacants?\s*[:\s]*(\d[\d\s,]*)/i);
        if (lvMatch) {
            data.logementsVacants = parseInt(lvMatch[1].replace(/[\s,]/g, ''), 10);
        }
        
        // Types de logements (Maisons vs Appartements)
        const maisonsMatch = text.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:de\s*)?maisons/i)
            || text.match(/maisons\s*[:\s]*(\d+(?:[.,]\d+)?)\s*%/i);
        const apptsMatch = text.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:d['']?\s*)?appartements/i)
            || text.match(/appartements\s*[:\s]*(\d+(?:[.,]\d+)?)\s*%/i);
        
        if (maisonsMatch || apptsMatch) {
            data.typesLogements = {
                maisons: maisonsMatch ? parseFloat(maisonsMatch[1].replace(',', '.')) : null,
                appartements: apptsMatch ? parseFloat(apptsMatch[1].replace(',', '.')) : null
            };
        }
        
        // Répartition par nombre de pièces (T1, T2, T3, etc.)
        data.repartitionPieces = {};
        
        // Pattern: "X% de 1 pièce" ou "1 pièce : X%"
        const piecePatterns = [
            { key: '1 pièce', regex: /(\d+(?:[.,]\d+)?)\s*%[^%]*?(?:de\s*)?1\s*pièce/i },
            { key: '1 pièce', regex: /1\s*pièces?\s*[:\s]*(\d+(?:[.,]\d+)?)\s*%/i },
            { key: '2 pièces', regex: /(\d+(?:[.,]\d+)?)\s*%[^%]*?(?:de\s*)?2\s*pièces/i },
            { key: '2 pièces', regex: /2\s*pièces?\s*[:\s]*(\d+(?:[.,]\d+)?)\s*%/i },
            { key: '3 pièces', regex: /(\d+(?:[.,]\d+)?)\s*%[^%]*?(?:de\s*)?3\s*pièces/i },
            { key: '3 pièces', regex: /3\s*pièces?\s*[:\s]*(\d+(?:[.,]\d+)?)\s*%/i },
            { key: '4 pièces', regex: /(\d+(?:[.,]\d+)?)\s*%[^%]*?(?:de\s*)?4\s*pièces/i },
            { key: '4 pièces', regex: /4\s*pièces?\s*[:\s]*(\d+(?:[.,]\d+)?)\s*%/i },
            { key: '5+ pièces', regex: /(\d+(?:[.,]\d+)?)\s*%[^%]*?(?:de\s*)?(?:5|plus\s*de\s*4)\s*pièces/i },
            { key: '5+ pièces', regex: /(?:5|plus\s*de\s*4)\s*pièces?\s*[:\s]*(\d+(?:[.,]\d+)?)\s*%/i }
        ];
        
        piecePatterns.forEach(({ key, regex }) => {
            const match = text.match(regex);
            if (match && !data.repartitionPieces[key]) {
                data.repartitionPieces[key] = parseFloat(match[1].replace(',', '.'));
            }
        });
        
        // Propriétaires vs Locataires
        const propMatch = text.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:de\s*)?propriétaires/i)
            || text.match(/propriétaires\s*[:\s]*(\d+(?:[.,]\d+)?)\s*%/i);
        const locMatch = text.match(/(\d+(?:[.,]\d+)?)\s*%\s*(?:de\s*)?locataires/i)
            || text.match(/locataires\s*[:\s]*(\d+(?:[.,]\d+)?)\s*%/i);
        
        if (propMatch) data.proprietaires = parseFloat(propMatch[1].replace(',', '.'));
        if (locMatch) data.locataires = parseFloat(locMatch[1].replace(',', '.'));
        
        // Année de construction
        const constructionMatch = text.match(/construits?\s*(?:avant|après)\s*(\d{4})[^%]*?(\d+(?:[.,]\d+)?)\s*%/i);
        if (constructionMatch) {
            data.anneeConstruction = {
                periode: constructionMatch[0].match(/avant|après/i)?.[0] + ' ' + constructionMatch[1],
                pourcentage: parseFloat(constructionMatch[2].replace(',', '.'))
            };
        }
        
        console.log("📊 Données L'Internaute parsées:", data);
        
    } catch (e) {
        console.error("Erreur parsing L'Internaute:", e);
    }
    
    return data;
}

function displayLInternauteData(data) {
    // Mettre à jour la répartition des logements
    if (data.repartitionPieces && Object.keys(data.repartitionPieces).length > 0) {
        const housingData = Object.entries(data.repartitionPieces).map(([label, percent]) => ({
            label: label,
            percent: percent
        }));
        displayHousingBars(housingData, true);
    }
    
    // Ajouter une section L'Internaute si des données sont disponibles
    const inseeCard = document.getElementById('inseeData');
    if (!inseeCard) return;
    
    let html = '';
    
    // Nombre de logements
    if (data.nbLogements) {
        html += `
            <div class="insee-stat">
                <span class="label">Total logements</span>
                <span class="value">${formatNumber(data.nbLogements)}</span>
            </div>
        `;
    }
    
    // Types de logements
    if (data.typesLogements) {
        if (data.typesLogements.maisons) {
            html += `
                <div class="insee-stat">
                    <span class="label">Maisons</span>
                    <span class="value">${data.typesLogements.maisons}%</span>
                </div>
            `;
        }
        if (data.typesLogements.appartements) {
            html += `
                <div class="insee-stat">
                    <span class="label">Appartements</span>
                    <span class="value">${data.typesLogements.appartements}%</span>
                </div>
            `;
        }
    }
    
    // Propriétaires vs Locataires
    if (data.proprietaires || data.locataires) {
        if (data.proprietaires) {
            html += `
                <div class="insee-stat">
                    <span class="label">Propriétaires</span>
                    <span class="value">${data.proprietaires}%</span>
                </div>
            `;
        }
        if (data.locataires) {
            html += `
                <div class="insee-stat">
                    <span class="label">Locataires</span>
                    <span class="value">${data.locataires}%</span>
                </div>
            `;
        }
    }
    
    // Résidences secondaires et vacants
    if (data.residencesSecondaires) {
        html += `
            <div class="insee-stat">
                <span class="label">Rés. secondaires</span>
                <span class="value">${formatNumber(data.residencesSecondaires)}</span>
            </div>
        `;
    }
    if (data.logementsVacants) {
        html += `
            <div class="insee-stat">
                <span class="label">Logements vacants</span>
                <span class="value">${formatNumber(data.logementsVacants)}</span>
            </div>
        `;
    }
    
    // Lien vers L'Internaute
    if (data.url) {
        html += `
            <a href="${data.url}" target="_blank" class="ma-link" style="margin-top: 16px; display: inline-flex;">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
                Voir sur L'Internaute
            </a>
        `;
    }
    
    if (html) {
        inseeCard.innerHTML += `
            <div class="insee-linternaute" style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border);">
                <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 12px; letter-spacing: 0.5px;">
                    Données INSEE (L'Internaute)
                </div>
                <div class="insee-stats-grid" style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px;">
                    ${html}
                </div>
            </div>
        `;
    }
}

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
    
    // Liens sources
    displaySourceLinks(commune);
    
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

function displayHousingBars(housingDist, fromLInternaute = false) {
    const container = document.getElementById('housingBars');
    
    // Si les données viennent de L'Internaute, mettre à jour le titre
    if (fromLInternaute) {
        const title = document.querySelector('#housingBars')?.closest('.card')?.querySelector('h3');
        if (title) {
            title.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                </svg>
                Répartition par Pièces
                <span style="font-size: 10px; color: var(--accent); margin-left: 8px; font-weight: normal;">INSEE</span>
            `;
        }
    }
    
    // Vérifier si on a des données
    const hasData = housingDist && housingDist.length > 0 && housingDist.some(h => h.percent > 0);
    
    if (!hasData) {
        container.innerHTML = `
            <div style="text-align: center; padding: 20px; color: var(--text-muted);">
                <p style="margin-bottom: 8px;">Données non disponibles</p>
                <p style="font-size: 12px; opacity: 0.7;">
                    Les données de répartition seront affichées si disponibles via L'Internaute
                </p>
            </div>
        `;
        return;
    }
    
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
    
    container.innerHTML = html;
}

function displayLInternauteError(commune) {
    const url = API_CONFIG.linternaute.buildUrl(commune.nom, commune.code);
    
    // Ajouter un lien dans la section démographie
    const demoGrid = document.getElementById('demoGrid');
    if (demoGrid) {
        const linkHtml = `
            <div class="demo-item" style="grid-column: span 2;">
                <a href="${url}" target="_blank" class="ma-link" style="font-size: 13px;">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    Plus de données INSEE sur L'Internaute
                </a>
            </div>
        `;
        demoGrid.insertAdjacentHTML('beforeend', linkHtml);
    }
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
// AFFICHAGE DES LIENS SOURCES
// ============================================

function displaySourceLinks(commune) {
    const container = document.getElementById('sourceLinks');
    if (!container) return;
    
    const deptCode = commune.departement?.code || commune.code.substring(0, 2);
    const cp = commune.codesPostaux?.[0] || '';
    
    const sources = [
        {
            name: 'DVF Etalab',
            desc: 'Transactions immobilières officielles',
            url: `https://app.dvf.etalab.gouv.fr/?code_departement=${deptCode}`,
            icon: '🏛️'
        },
        {
            name: 'Code source DVF',
            desc: 'GitHub Etalab - Open Source',
            url: 'https://github.com/etalab/DVF-app',
            icon: '💻'
        },
        {
            name: 'MeilleursAgents',
            desc: 'Estimations et prix du marché',
            url: API_CONFIG.sources.meilleursAgents.buildUrl(commune.nom, cp),
            icon: '📊'
        },
        {
            name: "L'Internaute",
            desc: 'Données INSEE détaillées',
            url: API_CONFIG.sources.linternaute.buildUrl(commune.nom, commune.code),
            icon: '📰'
        },
        {
            name: 'INSEE',
            desc: 'Statistiques officielles',
            url: API_CONFIG.sources.insee.buildUrl(commune.code),
            icon: '📈'
        },
        {
            name: 'Data.gouv.fr',
            desc: 'Télécharger les données DVF brutes',
            url: 'https://www.data.gouv.fr/fr/datasets/demandes-de-valeurs-foncieres/',
            icon: '📁'
        }
    ];
    
    const html = sources.map(s => `
        <a href="${s.url}" target="_blank" class="source-link-card">
            <div class="icon">${s.icon}</div>
            <div class="info">
                <div class="name">${s.name}</div>
                <div class="desc">${s.desc}</div>
            </div>
            <svg class="arrow" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
        </a>
    `).join('');
    
    container.innerHTML = html;
}

// ============================================
// EXPORT EXCEL
// ============================================

elements.exportBtn.addEventListener('click', exportToExcel);

function exportToExcel() {
    const { commune, stats, dvfTransactions, meilleursAgents, linternaute } = currentData;
    
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
    
    // Ajouter données L'Internaute/INSEE si disponibles
    if (linternaute) {
        syntheseData.push(['']);
        syntheseData.push(['DONNÉES INSEE (L\'INTERNAUTE)']);
        
        if (linternaute.nbLogements) {
            syntheseData.push(['Nombre total de logements', linternaute.nbLogements]);
        }
        if (linternaute.residencesPrincipales) {
            syntheseData.push(['Résidences principales', linternaute.residencesPrincipales]);
        }
        if (linternaute.residencesSecondaires) {
            syntheseData.push(['Résidences secondaires', linternaute.residencesSecondaires]);
        }
        if (linternaute.logementsVacants) {
            syntheseData.push(['Logements vacants', linternaute.logementsVacants]);
        }
        if (linternaute.typesLogements) {
            if (linternaute.typesLogements.maisons) {
                syntheseData.push(['Part maisons', linternaute.typesLogements.maisons + '%']);
            }
            if (linternaute.typesLogements.appartements) {
                syntheseData.push(['Part appartements', linternaute.typesLogements.appartements + '%']);
            }
        }
        if (linternaute.proprietaires) {
            syntheseData.push(['Propriétaires', linternaute.proprietaires + '%']);
        }
        if (linternaute.locataires) {
            syntheseData.push(['Locataires', linternaute.locataires + '%']);
        }
        
        // Répartition par pièces
        if (linternaute.repartitionPieces && Object.keys(linternaute.repartitionPieces).length > 0) {
            syntheseData.push(['']);
            syntheseData.push(['RÉPARTITION PAR NOMBRE DE PIÈCES']);
            Object.entries(linternaute.repartitionPieces).forEach(([pieces, percent]) => {
                syntheseData.push([pieces, percent + '%']);
            });
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
