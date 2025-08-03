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
const MINIMUM_PROFIT_THRESHOLD = 0.50; // Minimum €0.50 profit

// Rate limiting configuration - Skinport allows 8 requests per 5 minutes
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes in milliseconds
const MAX_REQUESTS_PER_WINDOW = 7; // Use 7 to be safe (was 5, now closer to the 8 limit)
const requestQueue = []; // Queue to store timestamps of requests

// Middleware
app.use(cors());
app.use(express.json());

// WEEKLY FLIP Trading Analysis - 3-7 Day Strategy for Best Accuracy & Sales
function analyzeWeeklyFlipViability(itemName, priceData, salesData, trend, stability) {
    const volume = priceData.volume;
    const avgPrice = priceData.avg;
    const maxPrice = priceData.max;
    const minPrice = priceData.min;
    const hasRecentActivity = salesData.last_7_days && salesData.last_7_days.volume > 0;
    
    let score = 0;
    let reasons = [];
    let recommendation = 'AVOID';
    
    // For weekly flips, we need good weekly volume (35% of score)
    const weeklyVolume = Math.max(volume / 4, salesData.last_7_days?.volume || 0); // Weekly estimate
    if (weeklyVolume >= 50) {
        score += 35;
        reasons.push('Excellent weekly volume (50+ sales) - reliable liquidity');
    } else if (weeklyVolume >= 25) {
        score += 30;
        reasons.push('Good weekly volume (25+ sales) - good liquidity');
    } else if (weeklyVolume >= 15) {
        score += 20;
        reasons.push('Moderate weekly volume (15+ sales) - decent liquidity');
    } else if (weeklyVolume >= 8) {
        score += 10;
        reasons.push('Low weekly volume (8+ sales) - may take longer');
    } else {
        reasons.push('Very low weekly volume (<8 sales) - RISKY');
    }
    
    // Price stability is important for 3-7 day holds (25% of score)
    const priceRange = maxPrice - minPrice;
    const priceStability = 100 - ((priceRange / avgPrice) * 100);
    if (priceStability >= 80) {
        score += 25;
        reasons.push('Very stable pricing (>80%) - low risk');
    } else if (priceStability >= 60) {
        score += 20;
        reasons.push('Stable pricing (60-80%) - manageable risk');
    } else if (priceStability >= 40) {
        score += 15;
        reasons.push('Somewhat stable pricing (40-60%)');
    } else if (priceStability >= 20) {
        score += 10;
        reasons.push('Unstable pricing (20-40%) - higher risk');
    } else {
        reasons.push('Very unstable pricing (<20%) - HIGH RISK');
    }
    
    // Market position - buying in bottom 30% is ideal (20% of score)
    const currentPos = (avgPrice - minPrice) / (maxPrice - minPrice || 1);
    if (currentPos <= 0.3) {
        score += 20;
        reasons.push('Excellent entry point (bottom 30% of range)');
    } else if (currentPos <= 0.5) {
        score += 15;
        reasons.push('Good entry point (below median)');
    } else if (currentPos <= 0.7) {
        score += 10;
        reasons.push('Fair entry point (above median)');
    } else {
        score += 5;
        reasons.push('Poor entry point (top 30% of range)');
    }
    
    // Recent activity check - should have sales within week (20% of score)
    if (hasRecentActivity) {
        const weeklyVol = salesData.last_7_days.volume;
        if (weeklyVol >= 20) {
            score += 20;
            reasons.push('High weekly activity (20+ sales this week)');
        } else if (weeklyVol >= 10) {
            score += 15;
            reasons.push('Good weekly activity (10+ sales this week)');
        } else if (weeklyVol >= 5) {
            score += 10;
            reasons.push('Moderate weekly activity (5+ sales this week)');
        } else {
            score += 5;
            reasons.push('Low weekly activity (1-4 sales this week)');
        }
    } else {
        reasons.push('No recent weekly activity - may take longer to sell');
    }
    
    // Determine recommendation for weekly flips
    if (score >= 80) {
        recommendation = 'WEEKLY_FLIP_EXCELLENT';
    } else if (score >= 65) {
        recommendation = 'WEEKLY_FLIP_GOOD';
    } else if (score >= 45) {
        recommendation = 'WEEKLY_FLIP_MODERATE';
    } else {
        recommendation = 'AVOID_WEEKLY_FLIP';
    }
    
    // Calculate weekly flip metrics
    let estimatedSellDays = '5-7'; // Default estimate
    let targetMarginPercentage = 10; // Realistic margins for weekly flips
    let sellProbability = 60;
    
    if (score >= 80) {
        estimatedSellDays = '1-3';
        targetMarginPercentage = 12;
        sellProbability = 90;
    } else if (score >= 65) {
        estimatedSellDays = '3-5';
        targetMarginPercentage = 10;
        sellProbability = 75;
    } else if (score >= 45) {
        estimatedSellDays = '5-7';
        targetMarginPercentage = 8;
        sellProbability = 60;
    } else {
        estimatedSellDays = '7+';
        targetMarginPercentage = 15;
        sellProbability = 40;
    }
    
    return {
        score,
        recommendation,
        reasons,
        estimatedSellDays,
        targetMarginPercentage,
        sellProbability,
        hasRecentActivity,
        priceStability: priceStability.toFixed(1),
        weeklyVolume: Math.round(weeklyVolume)
    };
}

// Calculate weekly flip selling strategy - balanced pricing for 3-7 day sales
function calculateWeeklyFlipStrategy(buyPrice, marketData, viability) {
    const avg = marketData.avg;
    const max = marketData.max;
    const min = marketData.min;
    
    // For weekly flips, we can price closer to average but still competitive
    // Target 75th-90th percentile for good balance of speed and profit
    
    // Quick sale pricing (3-4 days): 75th percentile 
    const quickSalePrice = min + ((avg - min) * 0.75);
    
    // Standard pricing (4-6 days): 80th percentile
    const standardPrice = min + ((avg - min) * 0.80);
    
    // Patient pricing (5-7 days): 85th percentile
    const patientPrice = min + ((avg - min) * 0.85);
    
    // Choose pricing based on viability and desired sell time
    let recommendedPrice;
    let expectedDays;
    
    if (viability.recommendation === 'WEEKLY_FLIP_EXCELLENT' && viability.score >= 80) {
        recommendedPrice = patientPrice; // Can afford to wait for better price
        expectedDays = '2-4';
    } else if (viability.recommendation === 'WEEKLY_FLIP_GOOD') {
        recommendedPrice = standardPrice; // Balanced approach
        expectedDays = '3-5';
    } else {
        recommendedPrice = quickSalePrice; // Price aggressively to ensure sale
        expectedDays = '4-7';
    }
    
    // Ensure minimum profit margin
    const minProfitMargin = 0.08; // 8% minimum
    const minPrice = buyPrice * (1 + minProfitMargin);
    if (recommendedPrice < minPrice) {
        recommendedPrice = minPrice;
        expectedDays = '5-7'; // Might take longer with higher price
    }
    
    return {
        quick: quickSalePrice,
        standard: standardPrice,
        patient: patientPrice,
        recommended: recommendedPrice,
        expectedProfit: recommendedPrice - buyPrice,
        expectedMargin: ((recommendedPrice - buyPrice) / buyPrice) * 100,
        expectedDays
    };
}

/**
 * Delays execution for a given number of milliseconds.
 */
function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Rate limiter that respects Skinport's 8 requests per 5 minutes limit.
 * We use 5 requests per 5 minutes to be conservative.
 */
async function waitForRateLimit() {
    const now = Date.now();
    
    // Remove old requests from the queue
    while (requestQueue.length > 0 && now - requestQueue[0] > RATE_LIMIT_WINDOW) {
        requestQueue.shift();
    }

    console.log(`[Rate Limiter] Current queue: ${requestQueue.length}/${MAX_REQUESTS_PER_WINDOW} requests in last ${RATE_LIMIT_WINDOW/1000}s`);

    if (requestQueue.length >= MAX_REQUESTS_PER_WINDOW) {
        // Queue is full, wait for the oldest request to expire
        const oldestRequestTime = requestQueue[0];
        const timeToWait = (oldestRequestTime + RATE_LIMIT_WINDOW) - now + 2000; // +2s buffer
        if (timeToWait > 0) {
            console.log(`[Rate Limiter] Rate limit reached. Waiting ${Math.round(timeToWait/1000)}s for the next available slot.`);
            await delay(timeToWait);
            
            // Clean up queue again after waiting
            const afterWait = Date.now();
            while (requestQueue.length > 0 && afterWait - requestQueue[0] > RATE_LIMIT_WINDOW) {
                requestQueue.shift();
            }
        }
    }
    
    // Add the new request timestamp to the queue
    requestQueue.push(Date.now());
    console.log(`[Rate Limiter] Request added. Queue now: ${requestQueue.length}/${MAX_REQUESTS_PER_WINDOW}`);
}

/**
 * Creates optimal batches based on URL length limits
 */
function createOptimalBatches(uniqueItems, maxUrlLength = 7000) {
    const batches = [];
    let currentBatch = [];
    let currentUrlLength = SKINPORT_API_URL.length + 100; // Base URL + params overhead
    
    // Helper function to clean and validate item names - MUCH MORE PERMISSIVE
    const cleanItemName = (name) => {
        // Only trim whitespace and normalize spaces - preserve all other characters
        return name.trim()
            .replace(/\s+/g, ' ');          // Normalize spaces only
    };

    // Filter and clean items before batching
    const validItems = uniqueItems
        .map(item => cleanItemName(item))
        .filter(item => {
            const isValid = item.length > 0 && item.length < 150; // Increased limit
            if (!isValid) {
                console.log(`[Batch] Skipping invalid item name: ${item}`);
            }
            return isValid;
        });
    
    for (const item of validItems) {
        const itemLength = encodeURIComponent(item).length + 1; // +1 for comma
        
        // If adding this item would exceed URL limit or we hit reasonable batch size
        if (currentUrlLength + itemLength > maxUrlLength || currentBatch.length >= 200) { // Increased from 100 to 200 items per batch
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
    // Validate and clean market hash names - MUCH MORE PERMISSIVE
    const validNames = marketHashNames.filter(name => {
        const isValid = typeof name === 'string' && 
                       name.trim().length > 0 && 
                       name.length < 200; // Increased length limit
                       // REMOVED overly strict character filtering
        
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
    const statTrakItems = items.filter(item => {
        const itemName = item.marketHashName || item.name;
        return itemName && itemName.includes('StatTrak');
    });
    if (statTrakItems.length > 0) {
        console.log(`[StatTrak Debug] Found ${statTrakItems.length} StatTrak items:`);
        statTrakItems.slice(0, 3).forEach(item => {
            const itemName = item.marketHashName || item.name;
            console.log(`  - Name: "${itemName}"`);
            console.log(`  - Unicode chars: ${Array.from(itemName).map(c => `${c}(${c.charCodeAt(0)})`).join(' ')}`);
        });
    }

    try {
        const analyzedItems = [];
        
        // Extract unique market hash names (item names)
        const uniqueNames = [...new Set(items.map(item => item.marketHashName || item.name).filter(name => name && name.trim()))];
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
            
            // Longer delay between batches to be more conservative with rate limiting
            if (i < batches.length - 1) {
                console.log(`[Backend] Waiting 3 seconds before next batch...`);
                await delay(3000); // Increased from 100ms to 3 seconds
            }
        }

        console.log(`[Backend] Got sales data for ${Object.keys(allSalesData).length} items.`);
        
        // Debug which StatTrak items got API data
        if (statTrakItems.length > 0) {
            console.log(`[StatTrak Debug] API Response check:`);
            statTrakItems.slice(0, 3).forEach(item => {
                const itemName = item.marketHashName || item.name;
                const hasData = allSalesData[itemName];
                console.log(`  - "${itemName}": ${hasData ? 'HAS DATA' : 'NO DATA'}`);
                if (!hasData) {
                    // Check if a similar name exists in the response
                    const similarKeys = Object.keys(allSalesData).filter(key => 
                        key.toLowerCase().includes(itemName.toLowerCase().replace(/[★™]/g, '').trim())
                    );
                    if (similarKeys.length > 0) {
                        console.log(`    Similar keys found: ${similarKeys.slice(0, 2)}`);
                    }
                }
            });
        }

        // Analyze each item for profitability
        for (const item of items) {
            const itemName = item.marketHashName || item.name;
            const itemPrice = item.price || item.skinportPrice;
            
            if (!itemName || !itemPrice) continue;

            const salesData = allSalesData[itemName];
            if (!salesData) {
                console.log(`[Backend] No sales data for: ${itemName}`);
                continue;
            }

            // Debug: Log the actual structure of salesData for first few items
            if (analyzedItems.length < 3) {
                console.log(`[Debug] SalesData structure for "${itemName}":`, JSON.stringify(salesData, null, 2));
            }

            // The Skinport API returns aggregated data, not individual sales
            // Use the most recent period with data (prefer 30 days, fallback to 90 days)
            let priceData = null;
            if (salesData.last_30_days && salesData.last_30_days.volume > 0 && salesData.last_30_days.avg !== null) {
                priceData = salesData.last_30_days;
                console.log(`[Backend] Using 30-day data for: ${itemName}`);
            } else if (salesData.last_90_days && salesData.last_90_days.volume > 0 && salesData.last_90_days.avg !== null) {
                priceData = salesData.last_90_days;
                console.log(`[Backend] Using 90-day data for: ${itemName}`);
            } else if (salesData.last_7_days && salesData.last_7_days.volume > 0 && salesData.last_7_days.avg !== null) {
                priceData = salesData.last_7_days;
                console.log(`[Backend] Using 7-day data for: ${itemName}`);
            } else if (salesData.last_24_hours && salesData.last_24_hours.volume > 0 && salesData.last_24_hours.avg !== null) {
                priceData = salesData.last_24_hours;
                console.log(`[Backend] Using 24-hour data for: ${itemName}`);
            }

            if (!priceData) {
                console.log(`[Backend] No usable price data for: ${itemName}`);
                continue;
            }

            // Extract price statistics from the aggregated data
            const avgPrice = priceData.avg;
            const minPrice = priceData.min;
            const maxPrice = priceData.max;
            const volume = priceData.volume;
            
            // Advanced variance and volatility analysis (for information only)
            const priceRange = maxPrice - minPrice;
            const coefficientOfVariation = (priceRange / avgPrice) * 100; // CV as percentage
            
            // WEEKLY FLIP TRADING: Enhanced volatility filtering for 3-7 day holds
            let priceStability;
            
            // Strict volatility control for weekly flip trading strategy
            const isDangerouslyVolatile = coefficientOfVariation > 300; // Keep strict for extreme cases like AWP Asiimov
            const isHighlyVolatile = coefficientOfVariation > 150; // Moderate threshold
            
            // Calculate trend first for stability calculation
            let trendIndicator = 'STABLE';
            if (salesData.last_7_days && salesData.last_30_days) {
                const recent7dAvg = salesData.last_7_days.avg;
                const older30dAvg = salesData.last_30_days.avg;
                const trendChange = ((recent7dAvg - older30dAvg) / older30dAvg) * 100;
                
                if (trendChange > 10) {
                    trendIndicator = 'RISING';
                } else if (trendChange < -10) {
                    trendIndicator = 'FALLING';
                }
                
                console.log(`[Trend] ${itemName}: ${trendChange.toFixed(1)}% change, trend=${trendIndicator}`);
            }
            
            const trendPenalty = trendIndicator === 'FALLING' ? 25 : trendIndicator === 'RISING' ? -5 : 0;
            
            if (isDangerouslyVolatile) {
                // Auto-reject items with extreme volatility (>200% CV) for weekly flip trading
                priceStability = 0;
                console.log(`[Weekly Flip] ${itemName}: REJECTED - Dangerously volatile (CV: ${coefficientOfVariation.toFixed(1)}%) - unsuitable for 3-7 day holds`);
            } else if (avgPrice < 2.0 && volume >= 1000) {
                // High-volume cases/consumables - acceptable for weekly trading with caution
                const lenientCV = Math.min(coefficientOfVariation * 0.6, 100);
                priceStability = Math.max(100 - lenientCV - trendPenalty, 20);
                console.log(`[Weekly Flip] ${itemName}: High-volume case - moderate risk for weekly holds`);
            } else if (volume >= 800) {
                // Very high volume items - more forgiving for weekly trading
                const adjustedCV = Math.min(coefficientOfVariation * 0.8, 100);
                priceStability = Math.max(100 - adjustedCV - trendPenalty, 15);
                console.log(`[Weekly Flip] ${itemName}: High-volume item - acceptable for weekly trading`);
            } else if (avgPrice < 1.0) {
                // Other cheap items - need good volume for weekly trading
                if (volume < 50) {
                    priceStability = 0; // Reject low-volume cheap items for weekly trading
                } else {
                    const adjustedCV = Math.min(coefficientOfVariation * 0.9, 100);
                    priceStability = Math.max(100 - adjustedCV - trendPenalty, 10);
                }
            } else if (avgPrice < 50.0) {
                // Mid-range items - balanced requirements for weekly trading
                if (isHighlyVolatile || volume < 25) {
                    const strictCV = Math.min(coefficientOfVariation * 1.1, 100);
                    priceStability = Math.max(100 - strictCV - trendPenalty, 5);
                } else {
                    const adjustedCV = Math.min(coefficientOfVariation * 0.95, 100);
                    priceStability = Math.max(100 - adjustedCV - trendPenalty, 10);
                }
            } else {
                // Expensive items (€50+) - careful but not overly strict for weekly trading
                if (isHighlyVolatile || volume < 15) {
                    const strictCV = Math.min(coefficientOfVariation * 1.3, 100);
                    priceStability = Math.max(100 - strictCV - trendPenalty, 0);
                } else {
                    const strictCV = Math.min(coefficientOfVariation * 1.1, 100);
                    priceStability = Math.max(100 - strictCV - trendPenalty, 8);
                    
                    // Moderate penalty for absolute price swings on expensive items
                    const absoluteSwingPenalty = Math.min((priceRange / avgPrice) * 20, 15);
                    priceStability = Math.max(priceStability - absoluteSwingPenalty, 0);
                }
            }
            
            // Ensure stability is never negative
            priceStability = Math.max(priceStability, 0);
            
            console.log(`[Weekly Flip Analysis] ${itemName}: CV=${coefficientOfVariation.toFixed(1)}%, Range=${priceRange.toFixed(2)}, Stability=${priceStability.toFixed(1)}%, AvgPrice=${avgPrice.toFixed(2)}, Volume=${volume}, Strategy=WEEKLY_FLIP`);
            
            // Early rejection for weekly flip trading - only extreme volatility cases
            if (coefficientOfVariation > 300) {
                console.log(`[Weekly Flip] ${itemName}: REJECTED - Coefficient of Variation (${coefficientOfVariation.toFixed(1)}%) exceeds 300% threshold for weekly trading`);
                continue; // Skip to next item
            }
            
            // Calculate weighted pricing across timeframes (prefer recent data)
            let weightedPrice = avgPrice;
            let combinedVolume = volume;
            let dataQuality = 'STANDARD';
            
            // Multi-timeframe analysis for better trend detection
            if (salesData.last_7_days && salesData.last_7_days.volume > 0) {
                const recent7d = salesData.last_7_days;
                const recent30d = salesData.last_30_days || priceData;
                
                // Weight recent sales more heavily (70% recent, 30% older)
                if (recent7d.volume >= 3) {
                    weightedPrice = (recent7d.avg * 0.7) + (recent30d.avg * 0.3);
                    combinedVolume = recent7d.volume + (recent30d.volume * 0.5);
                    dataQuality = 'HIGH'; // Recent activity available
                    console.log(`[Weighted] ${itemName}: 7d=${recent7d.avg.toFixed(2)} (70%) + 30d=${recent30d.avg.toFixed(2)} (30%) = ${weightedPrice.toFixed(2)}`);
                }
            }
            
            // Conservative percentile-based pricing instead of averages
            let percentilePrice;
            if (priceStability > 70) {
                // High stability: use 40th percentile (more aggressive)
                percentilePrice = minPrice + (priceRange * 0.40);
            } else if (priceStability > 50) {
                // Medium stability: use 30th percentile
                percentilePrice = minPrice + (priceRange * 0.30);
            } else {
                // Low stability: use 25th percentile (very conservative)
                percentilePrice = minPrice + (priceRange * 0.25);
            }
            
            // Use the lower of weighted average or percentile price for safety
            const conservativePrice = Math.min(weightedPrice, percentilePrice);
            
            console.log(`[Pricing] ${itemName}: Weighted=${weightedPrice.toFixed(2)}, Percentile=${percentilePrice.toFixed(2)}, Conservative=${conservativePrice.toFixed(2)}`);
            
            // Enhanced liquidity analysis with INSTANT FLIP focus
            let achievablePrice;
            let liquidityRating;
            let riskLevel;
            let profitConfidence;
            
            // Volume quality assessment - prioritize 24h activity for instant flips
            const hasRecentActivity = salesData.last_24_hours && salesData.last_24_hours.volume >= 1;
            const has24hHighActivity = salesData.last_24_hours && salesData.last_24_hours.volume >= 5;
            const volumeConsistency = has24hHighActivity ? 'EXCELLENT' : hasRecentActivity ? 'GOOD' : 'POOR';
            
            // Define dailyVolume for use throughout this section
            const dailyVolume = salesData.last_24_hours?.volume || 0;
            
            // INSTANT FLIP: Volume-first liquidity criteria with 24h activity bonus
            let isHighVolumeItem = false;
            let isUltraHighVolumeItem = volume >= 500; // Lower threshold for instant flips
            let volumeThreshold = {
                excellent: 10, // New tier for instant flips
                good: 5,
                medium: 3, 
                poor: 1 // Lower barrier for instant consideration
            };
            
            // Handle ultra-high-volume items first (excellent for instant flips)
            if (isUltraHighVolumeItem && hasRecentActivity) {
                console.log(`[Instant Liquidity] ${itemName}: Ultra-high-volume with recent activity (${volume} sales, 24h: ${salesData.last_24_hours?.volume || 0})`);
                if (volume >= 2000 && has24hHighActivity) {
                    liquidityRating = 'EXCELLENT';
                    achievablePrice = conservativePrice * 0.99; // Only 1% discount for instant flip
                    profitConfidence = Math.min(95, 85 + Math.min(volume * 0.001, 10)); 
                    riskLevel = 'VERY_LOW';
                } else if (volume >= 1000 && hasRecentActivity) {
                    liquidityRating = 'EXCELLENT';
                    achievablePrice = conservativePrice * 0.98; // 2% discount
                    profitConfidence = Math.min(90, 80 + Math.min(volume * 0.002, 10));
                    riskLevel = 'LOW';
                } else if (volume >= 500) {
                    liquidityRating = 'GOOD';
                    achievablePrice = conservativePrice * 0.97; // 3% discount
                    profitConfidence = Math.min(85, 75 + Math.min(volume * 0.005, 10));
                    riskLevel = priceStability > 20 ? 'LOW' : 'MEDIUM';
                }
            } else {
                // Adjust volume requirements based on 24h activity and total volume
                
                // Instant flip scoring: daily activity is CRITICAL
                if (dailyVolume >= 10 && volume >= 100) {
                    liquidityRating = 'EXCELLENT';
                    achievablePrice = conservativePrice * 0.98; // 2% discount for high daily activity
                    profitConfidence = Math.min(90, 70 + (dailyVolume * 2) + (priceStability * 0.2));
                    riskLevel = 'VERY_LOW';
                    isHighVolumeItem = true;
                } else if (dailyVolume >= 5 && volume >= 50) {
                    liquidityRating = 'GOOD';
                    achievablePrice = conservativePrice * 0.96; // 4% discount
                    profitConfidence = Math.min(85, 60 + (dailyVolume * 3) + (priceStability * 0.3));
                    riskLevel = 'LOW';
                    isHighVolumeItem = true;
                } else if (dailyVolume >= 2 && volume >= 30) {
                    liquidityRating = 'MEDIUM';
                    achievablePrice = conservativePrice * 0.94; // 6% discount
                    profitConfidence = Math.min(75, 45 + (dailyVolume * 5) + (priceStability * 0.3));
                    riskLevel = 'MEDIUM';
                } else if (dailyVolume >= 1 && volume >= 20) {
                    liquidityRating = 'POOR';
                    achievablePrice = conservativePrice * 0.91; // 9% discount
                    profitConfidence = Math.min(65, 35 + (dailyVolume * 8) + (priceStability * 0.2));
                    riskLevel = 'HIGH';
                } else if (volume >= 100) {
                    // High total volume but no recent activity - risky for instant flip
                    liquidityRating = 'POOR';
                    achievablePrice = conservativePrice * 0.88; // 12% discount
                    profitConfidence = Math.min(60, 30 + (volume * 0.1) + (priceStability * 0.2));
                    riskLevel = 'HIGH';
                } else {
                    liquidityRating = 'VERY_POOR';
                    achievablePrice = conservativePrice * 0.85; // 15% discount - not suitable for instant flip
                    profitConfidence = Math.min(50, 20 + (volume * 0.2) + (priceStability * 0.1));
                    riskLevel = 'VERY_HIGH';
                }
            }
            
            console.log(`[Instant Liquidity] ${itemName}: Volume=${volume}, Daily=${dailyVolume}, Rating=${liquidityRating}, Risk=${riskLevel}, Confidence=${profitConfidence.toFixed(0)}%`);
            
            // Apply Skinport's 8% seller fee to achievable price
            const netAchievablePrice = achievablePrice * 0.92; // After 8% fee
            
            // Calculate profit based on net achievable price
            const skinportPriceNum = typeof itemPrice === 'number' ? itemPrice : parseFloat(itemPrice.toString().replace(',', '.'));
            const profitAmount = netAchievablePrice - skinportPriceNum;
            const profitPercentage = ((profitAmount / skinportPriceNum) * 100);

            // Enhanced profit validation with risk assessment
            const minProfitAmount = parseFloat(settings.minProfitAmount || 0);
            const minProfitPercentage = parseFloat(settings.minProfitPercentage || 0);
            
            // TEMPORARILY DISABLED - Risk-adjusted profit requirements for testing
            let adjustedMinProfit = minProfitAmount;
            let adjustedMinPercentage = minProfitPercentage;
            
            // COMMENTED OUT - Increase minimum requirements for high-risk items
            // if (riskLevel === 'VERY_HIGH') {
            //     adjustedMinProfit *= 1.5; // Require 50% more profit for very high risk
            //     adjustedMinPercentage *= 1.3; // Require 30% higher percentage
            // } else if (riskLevel === 'HIGH') {
            //     adjustedMinProfit *= 1.25; // Require 25% more profit for high risk
            //     adjustedMinPercentage *= 1.15; // Require 15% higher percentage
            // }
            
            // Market trend analysis for additional validation (trend already calculated above)

            // WEEKLY FLIP ANALYSIS - 3-7 Day Strategy for Best Accuracy & Sales
            const weeklyFlipViability = analyzeWeeklyFlipViability(itemName, priceData, salesData, trendIndicator, priceStability);
            const weeklyFlipStrategy = calculateWeeklyFlipStrategy(skinportPriceNum, priceData, weeklyFlipViability);
            
            // ENHANCED profit validation with WEEKLY FLIP focus (balanced criteria for 3-7 day trading)
            const meetsBasicCriteria = profitAmount >= adjustedMinProfit && profitPercentage >= adjustedMinPercentage;
            const meetsConfidenceCriteria = profitConfidence >= 25; // Reasonable confidence for weekly holds
            const meetsStabilityCriteria = priceStability >= 8; // Balanced stability requirement
            const meetsWeeklyFlipCriteria = weeklyFlipViability.score >= 40; // Practical weekly flip threshold
            const hasGoodLiquidity = volume >= 30 && weeklyFlipViability.weeklyVolume >= 5; // Realistic liquidity requirements
            
            console.log(`[Validation] ${itemName}: Profit=${profitAmount.toFixed(2)}, Percentage=${profitPercentage.toFixed(1)}%, Confidence=${profitConfidence}%, Stability=${priceStability}%`);
            console.log(`[Weekly Flip] ${itemName}: Viability=${weeklyFlipViability.recommendation} (${weeklyFlipViability.score}/100), Days=${weeklyFlipViability.estimatedSellDays}`);
            console.log(`[Validation] Criteria: Basic=${meetsBasicCriteria}, Confidence=${meetsConfidenceCriteria}, Stability=${meetsStabilityCriteria}, WeeklyFlip=${meetsWeeklyFlipCriteria}, GoodLiquidity=${hasGoodLiquidity}`);
            
            if (meetsBasicCriteria && meetsConfidenceCriteria && meetsWeeklyFlipCriteria && hasGoodLiquidity) {
                analyzedItems.push({
                    ...item,
                    name: itemName,
                    skinportPrice: itemPrice,
                    steamAvgPrice: avgPrice.toFixed(2),
                    steamMinPrice: minPrice.toFixed(2),
                    steamMaxPrice: maxPrice.toFixed(2),
                    achievablePrice: netAchievablePrice.toFixed(2), // This is what user will actually get after fees
                    grossAchievablePrice: achievablePrice.toFixed(2), // Before fees - what to list at
                    conservativePrice: conservativePrice.toFixed(2), // Conservative estimate before discounts
                    profitAmount: profitAmount.toFixed(2),
                    profitPercentage: profitPercentage.toFixed(1),
                    salesCount: volume,
                    dataSource: priceData === salesData.last_24_hours ? '24h' : 
                               priceData === salesData.last_7_days ? '7d' : 
                               priceData === salesData.last_30_days ? '30d' : '90d',
                    lastSaleDate: 'Recent', // Aggregated data doesn't have specific dates
                    
                    // Enhanced risk and market analysis
                    coefficientOfVariation: coefficientOfVariation.toFixed(1),
                    priceStability: priceStability.toFixed(1),
                    trendIndicator: trendIndicator,
                    volumeConsistency: volumeConsistency,
                    dataQuality: dataQuality,
                    
                    // Properties expected by content script
                    profit: profitAmount,
                    profitConfidence: Math.round(profitConfidence),
                    riskLevel: riskLevel,
                    liquidity: {
                        rating: liquidityRating,
                        volume: volume,
                        consistency: volumeConsistency
                    },
                    recommendation: profitPercentage > 25 && liquidityRating === 'GOOD' && riskLevel === 'LOW' ? 'STRONG_BUY' : 
                                   profitPercentage > 15 && liquidityRating !== 'VERY_POOR' && profitConfidence > 50 ? 'BUY' : 
                                   profitPercentage > 8 ? 'CONSIDER' :
                                   profitPercentage < 5 && volume < 2 && priceStability < 10 ? 'AVOID' : 'HOLD',
                    
                    // WEEKLY FLIP TRADING SPECIFIC DATA
                    weeklyFlipTrading: {
                        viability: weeklyFlipViability.recommendation,
                        viabilityScore: weeklyFlipViability.score,
                        reasons: weeklyFlipViability.reasons,
                        estimatedSellDays: weeklyFlipViability.estimatedSellDays,
                        targetMarginPercentage: weeklyFlipViability.targetMarginPercentage,
                        sellProbability: weeklyFlipViability.sellProbability,
                        hasRecentActivity: weeklyFlipViability.hasRecentActivity,
                        priceStability: weeklyFlipViability.priceStability,
                        weeklyVolume: weeklyFlipViability.weeklyVolume
                    },
                    weeklyFlipStrategy: {
                        quickPrice: weeklyFlipStrategy.quick.toFixed(2),
                        standardPrice: weeklyFlipStrategy.standard.toFixed(2),
                        patientPrice: weeklyFlipStrategy.patient.toFixed(2),
                        recommendedPrice: weeklyFlipStrategy.recommended.toFixed(2),
                        expectedProfit: weeklyFlipStrategy.expectedProfit.toFixed(2),
                        expectedMargin: weeklyFlipStrategy.expectedMargin.toFixed(1),
                        expectedDays: weeklyFlipStrategy.expectedDays
                    },
                    
                    // Additional metadata for debugging
                    analysis: {
                        originalMinProfit: minProfitAmount,
                        adjustedMinProfit: adjustedMinProfit.toFixed(2),
                        originalMinPercentage: minProfitPercentage,
                        adjustedMinPercentage: adjustedMinPercentage.toFixed(1),
                        meetsBasicCriteria: meetsBasicCriteria,
                        meetsConfidenceCriteria: meetsConfidenceCriteria,
                        meetsStabilityCriteria: meetsStabilityCriteria
                    }
                });
                
                console.log(`[Enhanced Profit] ${itemName}:`);
                console.log(`  Profit: €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%)`);
                console.log(`  Risk: ${riskLevel}, Confidence: ${profitConfidence.toFixed(0)}%, Stability: ${priceStability.toFixed(1)}%`);
                console.log(`  Liquidity: ${liquidityRating}, Trend: ${trendIndicator}`);
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
