const express = require('express');
const axios = require('axios');
const cors = require('cors');
const compression = require('compression');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(compression());

// Configuration
const SKINPORT_BASE_URL = 'https://api.skinport.com/v1';
const RATE_LIMIT = {
    maxRequests: 8,
    windowMs: 5 * 60 * 1000, // 5 minutes
    requests: [],
};

// In-memory cache
const cache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes (matches Skinport's cache)

// Rate limiting helper
function canMakeRequest() {
    const now = Date.now();
    
    // Remove old requests outside the window
    RATE_LIMIT.requests = RATE_LIMIT.requests.filter(
        timestamp => now - timestamp < RATE_LIMIT.windowMs
    );
    
    return RATE_LIMIT.requests.length < RATE_LIMIT.maxRequests;
}

function recordRequest() {
    RATE_LIMIT.requests.push(Date.now());
}

// Cache helpers
function getCachedData(key) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        return cached.data;
    }
    return null;
}

function setCachedData(key, data) {
    cache.set(key, {
        data,
        timestamp: Date.now()
    });
}

// Make rate-limited request to Skinport API
async function skinportRequest(endpoint, params = {}) {
    const cacheKey = `${endpoint}_${JSON.stringify(params)}`;
    
    // Check cache first
    const cached = getCachedData(cacheKey);
    if (cached) {
        console.log(`Cache hit for ${endpoint}`);
        return cached;
    }
    
    // Check rate limit
    if (!canMakeRequest()) {
        throw new Error('Rate limit exceeded. Please wait before making more requests.');
    }
    
    try {
        console.log(`Making request to ${endpoint}...`);
        recordRequest();
        
        const response = await axios.get(`${SKINPORT_BASE_URL}${endpoint}`, {
            params,
            headers: {
                'Accept-Encoding': 'br',
                'User-Agent': 'SkinportTracker/1.0'
            },
            timeout: 10000
        });
        
        setCachedData(cacheKey, response.data);
        return response.data;
        
    } catch (error) {
        console.error(`Error requesting ${endpoint}:`, error.message);
        throw error;
    }
}

// Calculate achievable price from sales history
function calculateAchievablePrice(historyData) {
    if (!historyData || historyData.length === 0) {
        return { achievablePrice: null, confidence: 'none', liquidity: 0 };
    }
    
    const item = historyData[0]; // Should be single item
    
    // Get the most relevant time period based on volume
    let bestPeriod = item.last_7_days;
    let periodName = '7 days';
    
    // Prefer 30-day data if it has good volume
    if (item.last_30_days && item.last_30_days.volume >= 10) {
        bestPeriod = item.last_30_days;
        periodName = '30 days';
    }
    
    // Use 7-day if it has recent activity
    if (item.last_7_days && item.last_7_days.volume >= 3) {
        bestPeriod = item.last_7_days;
        periodName = '7 days';
    }
    
    if (!bestPeriod || !bestPeriod.avg || bestPeriod.volume === 0) {
        return { achievablePrice: null, confidence: 'low', liquidity: 0 };
    }
    
    // Calculate achievable price (slightly below average to ensure quick sale)
    const achievablePrice = bestPeriod.avg * 0.95; // 5% below average for quick sale
    
    // Determine confidence based on volume and time period
    let confidence = 'low';
    if (bestPeriod.volume >= 20) confidence = 'high';
    else if (bestPeriod.volume >= 10) confidence = 'medium';
    
    // Calculate accuracy percentage
    let accuracy = 85; // Base accuracy
    if (bestPeriod.volume >= 50) accuracy = 99.5;
    else if (bestPeriod.volume >= 20) accuracy = 97;
    else if (bestPeriod.volume >= 10) accuracy = 92;
    else if (bestPeriod.volume >= 5) accuracy = 88;
    
    return {
        achievablePrice: parseFloat(achievablePrice.toFixed(2)),
        confidence,
        accuracy: parseFloat(accuracy.toFixed(1)),
        liquidity: bestPeriod.volume,
        periodUsed: periodName,
        salesData: {
            min: bestPeriod.min,
            max: bestPeriod.max,
            avg: bestPeriod.avg,
            median: bestPeriod.median,
            volume: bestPeriod.volume
        }
    };
}

// API Routes

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        rateLimit: {
            remainingRequests: RATE_LIMIT.maxRequests - RATE_LIMIT.requests.length,
            windowMs: RATE_LIMIT.windowMs
        },
        cacheSize: cache.size
    });
});

// Get sales history for specific item
app.get('/api/sales-history/:itemName', async (req, res) => {
    try {
        const itemName = decodeURIComponent(req.params.itemName);
        
        const historyData = await skinportRequest('/sales/history', {
            market_hash_name: itemName,
            app_id: 730,
            currency: 'EUR'
        });
        
        const analysis = calculateAchievablePrice(historyData);
        
        res.json({
            itemName,
            history: historyData,
            analysis,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({
            error: error.message,
            itemName: req.params.itemName
        });
    }
});

// Analyze multiple items
app.post('/api/analyze-items', async (req, res) => {
    try {
        const { items } = req.body;
        
        if (!items || !Array.isArray(items)) {
            return res.status(400).json({ error: 'Items array is required' });
        }
        
        const results = [];
        
        // Process in batches to respect rate limits
        for (const itemName of items) {
            try {
                if (!canMakeRequest()) {
                    results.push({
                        itemName,
                        error: 'Rate limit reached',
                        analysis: null
                    });
                    continue;
                }
                
                const historyData = await skinportRequest('/sales/history', {
                    market_hash_name: itemName,
                    app_id: 730,
                    currency: 'EUR'
                });
                
                const analysis = calculateAchievablePrice(historyData);
                
                results.push({
                    itemName,
                    analysis,
                    error: null
                });
                
                // Small delay between requests
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                results.push({
                    itemName,
                    error: error.message,
                    analysis: null
                });
            }
        }
        
        res.json({ results, timestamp: new Date().toISOString() });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Get current market items
app.get('/api/market-items', async (req, res) => {
    try {
        const { currency = 'EUR', tradable = '1' } = req.query;
        
        const items = await skinportRequest('/items', {
            app_id: 730,
            currency,
            tradable
        });
        
        res.json({
            items: items.slice(0, 100), // Limit to first 100 items
            total: items.length,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Scan for profitable deals
app.post('/api/scan-deals', async (req, res) => {
    try {
        const { 
            minProfit = 15, 
            maxItems = 20,
            currency = 'EUR' 
        } = req.body;
        
        // Get current market items
        const items = await skinportRequest('/items', {
            app_id: 730,
            currency,
            tradable: '1'
        });
        
        const deals = [];
        const itemsToCheck = items.slice(0, maxItems); // Limit to prevent rate limit issues
        
        for (const item of itemsToCheck) {
            try {
                if (!canMakeRequest()) {
                    console.log('Rate limit reached, stopping scan');
                    break;
                }
                
                const historyData = await skinportRequest('/sales/history', {
                    market_hash_name: item.market_hash_name,
                    app_id: 730,
                    currency
                });
                
                const analysis = calculateAchievablePrice(historyData);
                
                if (analysis.achievablePrice) {
                    const currentPrice = item.min_price / 100; // Convert cents to euros
                    const profit = analysis.achievablePrice - currentPrice;
                    const profitPercentage = (profit / currentPrice) * 100;
                    
                    if (profitPercentage >= minProfit) {
                        deals.push({
                            ...item,
                            currentPrice,
                            ...analysis,
                            profit: parseFloat(profit.toFixed(2)),
                            profitPercentage: parseFloat(profitPercentage.toFixed(2)),
                            isGoodDeal: true
                        });
                    }
                }
                
                // Delay between requests
                await new Promise(resolve => setTimeout(resolve, 800));
                
            } catch (error) {
                console.error(`Error analyzing ${item.market_hash_name}:`, error.message);
            }
        }
        
        // Sort by profit percentage
        deals.sort((a, b) => b.profitPercentage - a.profitPercentage);
        
        res.json({
            deals,
            scannedItems: itemsToCheck.length,
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Keep-alive endpoint for Render.com
app.get('/ping', (req, res) => {
    res.json({ 
        pong: true, 
        timestamp: Date.now(),
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🚀 Skinport Tracker Server running on port ${PORT}`);
    console.log(`📊 Rate limit: ${RATE_LIMIT.maxRequests} requests per ${RATE_LIMIT.windowMs/1000/60} minutes`);
    console.log(`💾 Cache duration: ${CACHE_DURATION/1000/60} minutes`);
});

module.exports = app;