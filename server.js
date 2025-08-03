// API Server for Skinport Tracker (to be deployed on your Render server)
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import NodeCache from 'node-cache';

const app = express();
const port = process.env.PORT || 3000;

// Cache for API responses (5 minutes = 300 seconds, matching the Skinport cache)
const cache = new NodeCache({ stdTTL: 300, checkperiod: 120 });

// Skinport API Constants
const SKINPORT_API_URL = 'https://api.skinport.com/v1';
const APP_ID_CSGO = 730;
const SKINPORT_FEE = 0.08; // 8% seller fee

// Rate limiting configuration - Skinport allows 8 requests per 5 minutes
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes in milliseconds
const MAX_REQUESTS_PER_WINDOW = 7; // Use 7 to be safe
const requestQueue = []; // Queue to store timestamps of requests

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Delays execution for a given number of milliseconds.
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate limiter that respects Skinport's 8 requests per 5 minutes limit.
 */
async function waitForRateLimit() {
    const now = Date.now();
    // Remove old requests from the queue
    while (requestQueue.length > 0 && now - requestQueue[0] > RATE_LIMIT_WINDOW) {
        requestQueue.shift();
    }

    if (requestQueue.length >= MAX_REQUESTS_PER_WINDOW) {
        // Queue is full, wait for the oldest request to expire
        const oldestRequestTime = requestQueue[0];
        const timeToWait = (oldestRequestTime + RATE_LIMIT_WINDOW) - now + 1000; // +1s buffer
        if (timeToWait > 0) {
            console.log(`[Rate Limiter] Waiting ${Math.round(timeToWait/1000)}s for the next available slot.`);
            await delay(timeToWait);
        }
    }
    // Add the new request timestamp to the queue
    requestQueue.push(Date.now());
}

/**
 * Creates optimal batches based on URL length limits
 */
function createOptimalBatches(uniqueItems, maxUrlLength = 7000) {
    const batches = [];
    let currentBatch = [];
    let currentUrlLength = SKINPORT_API_URL.length + 100; // Base URL + params overhead
    
    // Helper function to clean and validate item names
    const cleanItemName = (name) => {
        // Remove any invalid characters and normalize
        return name.trim()
            .replace(/[^\x20-\x7E]/g, '') // Remove non-printable characters
            .replace(/\s+/g, ' ');        // Normalize spaces
    };

    // Filter and clean items before batching
    const validItems = uniqueItems
        .map(item => cleanItemName(item))
        .filter(item => {
            const isValid = item.length > 0 && item.length < 100;
            if (!isValid) {
                console.log(`[Batch] Skipping invalid item name: ${item}`);
            }
            return isValid;
        });
    
    for (const item of validItems) {
        const itemLength = encodeURIComponent(item).length + 1; // +1 for comma
        
        // If adding this item would exceed URL limit or we hit reasonable batch size
        if (currentUrlLength + itemLength > maxUrlLength || currentBatch.length >= 100) { // Reduced max batch size
            if (currentBatch.length > 0) {
                batches.push([...currentBatch]);
                currentBatch = [];
                currentUrlLength = SKINPORT_API_URL.length + 100;
            }
        }
        
        currentBatch.push(item);
        currentUrlLength += itemLength;
    }
    
    // Add remaining items
    if (currentBatch.length > 0) {
        batches.push(currentBatch);
    }
    
    return batches;
}

/**
 * Fetches sales history for multiple items in a single API call
 */
async function fetchSalesHistoryBatch(marketHashNames, currency) {
    // Validate and clean market hash names
    const validNames = marketHashNames.filter(name => {
        const isValid = typeof name === 'string' && 
                       name.trim().length > 0 && 
                       name.length < 100 &&
                       !/[^\x20-\x7E]/.test(name); // Only printable ASCII characters
        
        if (!isValid) {
            console.log(`[API] Skipping invalid market_hash_name: ${name}`);
        }
        return isValid;
    }).map(name => name.trim());

    if (validNames.length === 0) {
        console.log(`[API] No valid items in batch`);
        return {};
    }

    const batchKey = `batch_${validNames.sort().join(',')}_${currency}`;
    const cachedData = cache.get(batchKey);

    if (cachedData) {
        console.log(`[Cache] Batch cache hit for ${validNames.length} items`);
        return cachedData;
    }

    try {
        await waitForRateLimit();
        
        // Let URLSearchParams handle the encoding automatically
        const marketHashNamesParam = validNames.join(',');
            
        const params = new URLSearchParams({
            app_id: APP_ID_CSGO,
            currency: currency,
            market_hash_name: marketHashNamesParam
        });
        
        const url = `${SKINPORT_API_URL}/sales/history?${params}`;
        console.log(`[API Call] Fetching batch of ${validNames.length} items`);
        console.log(`[API Call] Sample names:`, validNames.slice(0, 3));
        console.log(`[API Call] Full URL:`, url.substring(0, 300) + '...');
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept-Encoding': 'br',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            const responseText = await response.text();
            console.error(`[API Error] Failed to fetch batch sales history. Status: ${response.status} ${response.statusText}`);
            console.error(`[API Error] Response body: ${responseText.substring(0, 200)}...`);
            
            // Add retry logic for 502 errors
            if (response.status === 502) {
                console.log('[API Error] Received 502 Bad Gateway, waiting 5 seconds before retry...');
                await delay(5000); // Wait 5 seconds
                
                // Try the request again
                const retryResponse = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'Accept-Encoding': 'br',
                        'Accept': 'application/json',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                
                if (retryResponse.ok) {
                    return await retryResponse.json();
                } else {
                    console.error('[API Error] Retry also failed');
                }
            }
            
            return {};
        }

        const data = await response.json();
        console.log(`[API Response] Received data type:`, Array.isArray(data) ? 'Array' : typeof data);
        console.log(`[API Response] Data length/keys:`, Array.isArray(data) ? data.length : Object.keys(data).length);
        console.log(`[API Response] Sample data:`, JSON.stringify(data).substring(0, 200) + '...');
        
        // Convert array response to object with market_hash_name as key
        const batchData = {};
        if (Array.isArray(data)) {
            console.log(`[API Response] Processing ${data.length} items from API`);
            console.log(`[API Response] First 3 API item names:`, data.slice(0, 3).map(item => item.market_hash_name));
            
            data.forEach(item => {
                if (item.market_hash_name) {
                    batchData[item.market_hash_name] = item;
                }
            });
            
            // Debug: Show which requested items were found vs missing
            console.log(`[API Response] Requested ${validNames.length} items, got ${Object.keys(batchData).length} responses`);
            
            const foundItems = Object.keys(batchData);
            const missingItems = validNames.filter(name => !foundItems.includes(name));
            
            // Debug StatTrak items specifically
            const requestedStatTrak = validNames.filter(name => name.includes('StatTrak'));
            const receivedStatTrak = foundItems.filter(name => name.includes('StatTrak'));
            
            if (requestedStatTrak.length > 0) {
                console.log(`[API Debug] StatTrak requested (${requestedStatTrak.length}):`, requestedStatTrak.slice(0, 3));
                console.log(`[API Debug] StatTrak received (${receivedStatTrak.length}):`, receivedStatTrak.slice(0, 3));
                
                // Check for exact mismatches
                const missingStatTrak = requestedStatTrak.filter(name => !foundItems.includes(name));
                if (missingStatTrak.length > 0) {
                    console.log(`[API Debug] Missing StatTrak items (${missingStatTrak.length}):`, missingStatTrak.slice(0, 3));
                    
                    // Try to find similar names in the API response for first missing item
                    const firstMissing = missingStatTrak[0];
                    const weaponPart = firstMissing.split('|')[1]?.trim().split('(')[0]?.trim();
                    if (weaponPart) {
                        const similarNames = foundItems.filter(apiName => 
                            apiName.includes('StatTrak') && 
                            apiName.toLowerCase().includes(weaponPart.toLowerCase())
                        );
                        if (similarNames.length > 0) {
                            console.log(`[API Debug] Similar names for "${firstMissing}":`, similarNames);
                        }
                    }
                }
            }
            
            if (missingItems.length > 0) {
                console.log(`[API Response] Missing items (${missingItems.length}):`, missingItems.slice(0, 5));
            }
        }
        
        // Cache the batch response
        cache.set(batchKey, batchData);
        console.log(`[Cache] Batch cache set for ${validNames.length} items`);
        
        return batchData;
        
    } catch (error) {
        console.error(`[Data Collection] Error fetching batch sales history: ${error.message}`);
        return {};
    }
}

// API endpoint to receive prices and return deals
app.post('/analyze-prices', async (req, res) => {
    const { items, settings } = req.body;
    if (!items || !Array.isArray(items) || !settings) {
        return res.status(400).json({ error: 'Invalid input. Expected an array of items and settings.' });
    }

    console.log(`[Backend] Received ${items.length} items for analysis.`);
    console.log(`[Backend] Sample items:`, items.slice(0, 3));
    
    // Debug StatTrak items specifically
    const statTrakItems = items.filter(item => item.name && item.name.includes('StatTrak'));
    if (statTrakItems.length > 0) {
        console.log(`[StatTrak Debug] Found ${statTrakItems.length} StatTrak items:`);
        statTrakItems.slice(0, 3).forEach(item => {
            console.log(`  - Name: "${item.name}"`);
            console.log(`  - Unicode chars: ${Array.from(item.name).map(c => `${c}(${c.charCodeAt(0)})`).join(' ')}`);
        });
    }

    try {
        const analyzedItems = [];
        
        // Extract unique market hash names (item names)
        const uniqueNames = [...new Set(items.map(item => item.name).filter(name => name && name.trim()))];
        console.log(`[Backend] Extracted ${uniqueNames.length} unique item names.`);

        if (uniqueNames.length === 0) {
            return res.json({ 
                analyzedItems, 
                summary: { totalProcessed: 0, profitableFound: 0, message: 'No valid item names found' }
            });
        }

        // Create optimal batches
        const batches = createOptimalBatches(uniqueNames);
        console.log(`[Backend] Split into ${batches.length} batches.`);

        // Fetch sales data for all batches
        const allSalesData = {};
        for (let i = 0; i < batches.length; i++) {
            console.log(`[Backend] Processing batch ${i + 1}/${batches.length} (${batches[i].length} items)`);
            const batchData = await fetchSalesHistoryBatch(batches[i], settings.currency || 'EUR');
            Object.assign(allSalesData, batchData);
            
            // Small delay between batches to be respectful
            if (i < batches.length - 1) {
                await delay(100);
            }
        }

        console.log(`[Backend] Got sales data for ${Object.keys(allSalesData).length} items.`);
        
        // Debug which StatTrak items got API data
        if (statTrakItems.length > 0) {
            console.log(`[StatTrak Debug] API Response check:`);
            statTrakItems.slice(0, 3).forEach(item => {
                const hasData = allSalesData[item.name];
                console.log(`  - "${item.name}": ${hasData ? 'HAS DATA' : 'NO DATA'}`);
                if (!hasData) {
                    // Check if a similar name exists in the response
                    const similarKeys = Object.keys(allSalesData).filter(key => 
                        key.toLowerCase().includes(item.name.toLowerCase().replace(/[★™]/g, '').trim())
                    );
                    if (similarKeys.length > 0) {
                        console.log(`    Similar keys found: ${similarKeys.slice(0, 2)}`);
                    }
                }
            });
        }

        // Analyze each item for profitability
        for (const item of items) {
            if (!item.name || !item.skinportPrice) continue;

            const salesData = allSalesData[item.name];
            if (!salesData) {
                console.log(`[Backend] No sales data for: ${item.name}`);
                continue;
            }

            // Calculate statistics
            const prices = salesData.map(sale => sale.price);
            if (prices.length === 0) continue;

            const avgPrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
            const minPrice = Math.min(...prices);
            const maxPrice = Math.max(...prices);
            
            // Calculate profit
            const skinportPriceNum = parseFloat(item.skinportPrice.replace(',', '.'));
            const profitAmount = avgPrice - skinportPriceNum;
            const profitPercentage = ((profitAmount / skinportPriceNum) * 100);

            // Check if it meets profit criteria
            const minProfitAmount = parseFloat(settings.minProfitAmount || 0);
            const minProfitPercentage = parseFloat(settings.minProfitPercentage || 0);

            if (profitAmount >= minProfitAmount && profitPercentage >= minProfitPercentage) {
                analyzedItems.push({
                    ...item,
                    steamAvgPrice: avgPrice.toFixed(2),
                    steamMinPrice: minPrice.toFixed(2),
                    steamMaxPrice: maxPrice.toFixed(2),
                    profitAmount: profitAmount.toFixed(2),
                    profitPercentage: profitPercentage.toFixed(1),
                    salesCount: salesData.length,
                    lastSaleDate: salesData[0]?.date || 'Unknown'
                });
                
                console.log(`[Profit] Found profitable item: ${item.name} - €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%)`);
            }
        }

        console.log(`[Backend] Analysis complete. Found ${analyzedItems.length} profitable items.`);
        
        res.json({ 
            analyzedItems,
            summary: {
                totalProcessed: items.length,
                profitableFound: analyzedItems.length,
                uniqueItemsChecked: uniqueNames.length,
                salesDataFound: Object.keys(allSalesData).length,
                batchesProcessed: batches.length
            }
        });
    } catch (error) {
        console.error(`[Backend] Failed to analyze prices: ${error}`);
        res.status(500).json({ error: 'Failed to process items.' });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        rateLimit: {
            requestsInQueue: requestQueue.length,
            maxRequests: MAX_REQUESTS_PER_WINDOW,
            windowMinutes: 5
        }
    });
});

// Start Express server
app.listen(port, () => {
    console.log(`Enhanced Skinport Tracker API listening on port ${port}`);
    console.log(`Server started successfully with basic API endpoint`);
});
