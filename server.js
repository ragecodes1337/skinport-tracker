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
const MINIMUM_PROFIT_THRESHOLD = 0.20; // Minimum €0.20 profit (lowered from €0.50 for more opportunities)

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
    
    // For weekly flips, we need good weekly volume (35% of score) - LOWERED THRESHOLDS
    const weeklyVolume = Math.max(volume / 4, salesData.last_7_days?.volume || 0); // Weekly estimate
    if (weeklyVolume >= 30) { // Lowered from 50
        score += 35;
        reasons.push('Excellent weekly volume (30+ sales) - reliable liquidity');
    } else if (weeklyVolume >= 15) { // Lowered from 25
        score += 30;
        reasons.push('Good weekly volume (15+ sales) - good liquidity');
    } else if (weeklyVolume >= 8) { // Lowered from 15
        score += 20;
        reasons.push('Moderate weekly volume (8+ sales) - decent liquidity');
    } else if (weeklyVolume >= 4) { // Lowered from 8
        score += 15; // Increased score for this tier
        reasons.push('Low weekly volume (4+ sales) - may take longer');
    } else if (weeklyVolume >= 2) { // New tier for very low volume
        score += 10;
        reasons.push('Very low weekly volume (2+ sales) - higher risk but possible');
    } else {
        score += 5; // Give some points even for minimal volume
        reasons.push('Minimal weekly volume (<2 sales) - HIGH RISK but not impossible');
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
    
    // Recent activity check - should have sales within week (20% of score) - LOWERED THRESHOLDS
    if (hasRecentActivity) {
        const weeklyVol = salesData.last_7_days.volume;
        if (weeklyVol >= 15) { // Lowered from 20
            score += 20;
            reasons.push('High weekly activity (15+ sales this week)');
        } else if (weeklyVol >= 7) { // Lowered from 10
            score += 17; // Increased score
            reasons.push('Good weekly activity (7+ sales this week)');
        } else if (weeklyVol >= 3) { // Lowered from 5
            score += 15; // Increased score
            reasons.push('Moderate weekly activity (3+ sales this week)');
        } else if (weeklyVol >= 1) { // Lowered threshold
            score += 12; // Increased score
            reasons.push('Low weekly activity (1+ sales this week)');
        } else {
            score += 8; // Give some points even if no recent sales
            reasons.push('Minimal weekly activity but still trackable');
        }
    } else {
        score += 5; // Give some base points even without recent activity
        reasons.push('No recent weekly activity data - estimated from total volume');
    }
    
    // Determine recommendation for weekly flips - LOWERED THRESHOLDS
    if (score >= 65) { // Lowered from 80
        recommendation = 'WEEKLY_FLIP_EXCELLENT';
    } else if (score >= 45) { // Lowered from 65
        recommendation = 'WEEKLY_FLIP_GOOD';
    } else if (score >= 25) { // Lowered from 45
        recommendation = 'WEEKLY_FLIP_MODERATE';
    } else {
        recommendation = 'AVOID_WEEKLY_FLIP';
    }
    
    // Calculate weekly flip metrics - ADJUSTED THRESHOLDS
    let estimatedSellDays = '5-7'; // Default estimate
    let targetMarginPercentage = 10; // Realistic margins for weekly flips
    let sellProbability = 60;
    
    if (score >= 65) { // Lowered from 80
        estimatedSellDays = '1-3';
        targetMarginPercentage = 12;
        sellProbability = 90;
    } else if (score >= 45) { // Lowered from 65
        estimatedSellDays = '3-5';
        targetMarginPercentage = 10;
        sellProbability = 75;
    } else if (score >= 25) { // Lowered from 45
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
    
    if (viability.recommendation === 'WEEKLY_FLIP_EXCELLENT' && viability.score >= 65) { // Lowered from 80
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
 * Fetches Skinport current market listings for multiple items in a single API call
 */
async function fetchSkinportListingsBatch(marketHashNames, currency) {
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
        
        const url = `${SKINPORT_API_URL}/items?${params}`;
        console.log(`[API Call] Fetching Skinport listings for batch of ${validNames.length} items`);
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
            console.error(`[API Error] Failed to fetch Skinport listings. Status: ${response.status} ${response.statusText}`);
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
            console.log(`[API Response] Processing ${data.length} Skinport listings from API`);
            console.log(`[API Response] First 3 API item names:`, data.slice(0, 3).map(item => item.market_hash_name));
            
            data.forEach(item => {
                if (item.market_hash_name) {
                    // Process Skinport listing data - find lowest prices
                    const processedItem = {
                        market_hash_name: item.market_hash_name,
                        listings: item.items || [],
                        lowestPrice: null,
                        averagePrice: null,
                        highestPrice: null,
                        listingCount: 0
                    };
                    
                    if (processedItem.listings && processedItem.listings.length > 0) {
                        const prices = processedItem.listings.map(listing => listing.price).filter(p => p > 0);
                        if (prices.length > 0) {
                            processedItem.lowestPrice = Math.min(...prices);
                            processedItem.averagePrice = prices.reduce((a, b) => a + b, 0) / prices.length;
                            processedItem.highestPrice = Math.max(...prices);
                            processedItem.listingCount = prices.length;
                        }
                    }
                    
                    batchData[item.market_hash_name] = processedItem;
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
        console.error(`[Data Collection] Error fetching Skinport listings: ${error.message}`);
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

        // Fetch Skinport listing data for all batches
        const allListingData = {};
        for (let i = 0; i < batches.length; i++) {
            console.log(`[Backend] Processing batch ${i + 1}/${batches.length} (${batches[i].length} items)`);
            const batchData = await fetchSkinportListingsBatch(batches[i], settings.currency || 'EUR');
            Object.assign(allListingData, batchData);
            
            // Longer delay between batches to be more conservative with rate limiting
            if (i < batches.length - 1) {
                console.log(`[Backend] Waiting 3 seconds before next batch...`);
                await delay(3000); // Increased from 100ms to 3 seconds
            }
        }

        console.log(`[Backend] Got Skinport listing data for ${Object.keys(allListingData).length} items.`);
        
        // Debug which StatTrak items got Skinport listing data
        if (statTrakItems.length > 0) {
            console.log(`[StatTrak Debug] Skinport Listings Response check:`);
            statTrakItems.slice(0, 3).forEach(item => {
                const itemName = item.marketHashName || item.name;
                const hasData = allListingData[itemName];
                console.log(`  - "${itemName}": ${hasData ? 'HAS DATA' : 'NO DATA'}`);
                if (!hasData) {
                    // Check if a similar name exists in the response
                    const similarKeys = Object.keys(allListingData).filter(key => 
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

            const listingData = allListingData[itemName];
            if (!listingData || !listingData.lowestPrice) {
                console.log(`[Backend] No Skinport listing data for: ${itemName}`);
                continue;
            }

            // Debug: Log the actual structure of listingData for first few items
            if (analyzedItems.length < 3) {
                console.log(`[Debug] ListingData structure for "${itemName}":`, JSON.stringify(listingData, null, 2));
            }

            // Use Skinport listing data for profit analysis
            const lowestSellPrice = listingData.lowestPrice;
            const avgSellPrice = listingData.averagePrice;
            const highestSellPrice = listingData.highestPrice;
            const listingCount = listingData.listingCount;
            // Calculate profit potential based on Skinport buy vs sell prices
            const skinportBuyPrice = typeof itemPrice === 'number' ? itemPrice : parseFloat(itemPrice.toString().replace(',', '.'));
            
            // For Skinport flipping, we compare buy price to current sell listings
            // We need to undercut the lowest listing to sell quickly
            const competitiveSellPrice = lowestSellPrice * 0.95; // Undercut by 5% for quick sale
            const conservativeSellPrice = lowestSellPrice * 0.90; // Undercut by 10% for guaranteed sale
            const aggressiveSellPrice = lowestSellPrice * 0.98; // Undercut by 2% for maximum profit
            
            // After Skinport's 8% seller fee
            const netCompetitivePrice = competitiveSellPrice * 0.92;
            const netConservativePrice = conservativeSellPrice * 0.92;
            const netAggressivePrice = aggressiveSellPrice * 0.92;
            
            // Calculate profits for different strategies
            const competitiveProfit = netCompetitivePrice - skinportBuyPrice;
            const conservativeProfit = netConservativePrice - skinportBuyPrice;
            const aggressiveProfit = netAggressivePrice - skinportBuyPrice;
            
            const competitiveProfitPercentage = (competitiveProfit / skinportBuyPrice) * 100;
            const conservativeProfitPercentage = (conservativeProfit / skinportBuyPrice) * 100;
            const aggressiveProfitPercentage = (aggressiveProfit / skinportBuyPrice) * 100;
            
            // Advanced variance and volatility analysis based on current listings
            const priceRange = highestSellPrice - lowestSellPrice;
            const coefficientOfVariation = (priceRange / avgSellPrice) * 100; // CV as percentage
            
            console.log(`[Skinport Analysis] ${itemName}:`);
            console.log(`  Buy Price: €${skinportBuyPrice.toFixed(2)}`);
            console.log(`  Sell Range: €${lowestSellPrice.toFixed(2)} - €${highestSellPrice.toFixed(2)} (${listingCount} listings)`);
            console.log(`  Aggressive (2% undercut): €${aggressiveSellPrice.toFixed(2)} → €${netAggressivePrice.toFixed(2)} net → €${aggressiveProfit.toFixed(2)} profit (${aggressiveProfitPercentage.toFixed(1)}%)`);
            console.log(`  Competitive (5% undercut): €${competitiveSellPrice.toFixed(2)} → €${netCompetitivePrice.toFixed(2)} net → €${competitiveProfit.toFixed(2)} profit (${competitiveProfitPercentage.toFixed(1)}%)`);
            console.log(`  Conservative (10% undercut): €${conservativeSellPrice.toFixed(2)} → €${netConservativePrice.toFixed(2)} net → €${conservativeProfit.toFixed(2)} profit (${conservativeProfitPercentage.toFixed(1)}%)`);
            
            // Use competitive strategy for main analysis (5% undercut is balanced)
            const achievablePrice = competitiveSellPrice;
            const netAchievablePrice = netCompetitivePrice;
            const profitAmount = competitiveProfit;
            const profitPercentage = competitiveProfitPercentage;
            
            // Skip items with no profit potential
            if (profitAmount <= 0) {
                console.log(`[Skinport] ${itemName}: No profit potential - skipping`);
                continue;
            }

            // Enhanced profit validation - SIMPLIFIED for Skinport-to-Skinport trading
            const minProfitAmount = parseFloat(settings.minProfitAmount || 0);
            const minProfitPercentage = parseFloat(settings.minProfitPercentage || 0);
            
            // Basic criteria: does it meet minimum profit requirements?
            const meetsBasicCriteria = profitAmount >= minProfitAmount && profitPercentage >= minProfitPercentage;
            
            // Listing quality: how many competing sellers are there?
            const hasGoodLiquidity = listingCount >= 2 && listingCount <= 20; // Sweet spot: not too few, not too many
            const liquidityRating = listingCount >= 10 ? 'HIGH' : listingCount >= 5 ? 'MEDIUM' : listingCount >= 2 ? 'LOW' : 'VERY_LOW';
            
            // Price stability: how spread out are the current listings?
            const priceStability = listingCount > 1 ? Math.max(0, 100 - coefficientOfVariation) : 50;
            const isStable = priceStability >= 30; // 30% is reasonable for current market conditions
            
            console.log(`[Validation] ${itemName}: Profit=${profitAmount.toFixed(2)}€ (${profitPercentage.toFixed(1)}%), Listings=${listingCount}, Stability=${priceStability.toFixed(1)}%`);
            console.log(`[Validation] Criteria: Basic=${meetsBasicCriteria}, Liquidity=${hasGoodLiquidity}, Stable=${isStable}`);
            
            if (meetsBasicCriteria && hasGoodLiquidity && isStable) {
                analyzedItems.push({
                    ...item,
                    name: itemName,
                    skinportPrice: itemPrice,
                    skinportLowestSell: lowestSellPrice.toFixed(2),
                    skinportAvgSell: avgSellPrice.toFixed(2),
                    skinportHighestSell: highestSellPrice.toFixed(2),
                    achievablePrice: netAchievablePrice.toFixed(2), // What you'll actually get after fees
                    grossAchievablePrice: achievablePrice.toFixed(2), // What to list at before fees
                    profitAmount: profitAmount.toFixed(2),
                    profitPercentage: profitPercentage.toFixed(1),
                    listingCount: listingCount,
                    priceStability: priceStability.toFixed(1),
                    liquidityRating: liquidityRating,
                    
                    // Strategy details
                    strategies: {
                        aggressive: {
                            price: aggressiveSellPrice.toFixed(2),
                            netPrice: netAggressivePrice.toFixed(2),
                            profit: aggressiveProfit.toFixed(2),
                            profitPercent: aggressiveProfitPercentage.toFixed(1)
                        },
                        competitive: {
                            price: competitiveSellPrice.toFixed(2),
                            netPrice: netCompetitivePrice.toFixed(2),
                            profit: competitiveProfit.toFixed(2),
                            profitPercent: competitiveProfitPercentage.toFixed(1)
                        },
                        conservative: {
                            price: conservativeSellPrice.toFixed(2),
                            netPrice: netConservativePrice.toFixed(2),
                            profit: conservativeProfit.toFixed(2),
                            profitPercent: conservativeProfitPercentage.toFixed(1)
                        }
                    },
                    
                    recommendation: profitPercentage > 20 ? 'STRONG_BUY' : 
                                   profitPercentage > 10 ? 'BUY' : 
                                   profitPercentage > 5 ? 'CONSIDER' : 'HOLD'
                });
                
                console.log(`[Enhanced Profit] ${itemName}:`);
                console.log(`  Profit: €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%)`);
                console.log(`  Risk: ${liquidityRating}, Confidence: ${priceStability.toFixed(1)}%, Listings: ${listingCount}`);
                console.log(`  Liquidity: ${liquidityRating}, Trend: STABLE`);
            } else if (profitAmount >= -2.0) {
                // Log items that are close to profitable for debugging
                console.log(`[Almost Profitable] ${itemName}:`);
                console.log(`  Buy Price: €${skinportBuyPrice.toFixed(2)}, Lowest Sell: €${lowestSellPrice.toFixed(2)}, After Fees: €${netAchievablePrice.toFixed(2)}`);
                console.log(`  Profit: €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%) - Missing profit by €${Math.abs(profitAmount).toFixed(2)}`);
                console.log(`  Failed criteria: Basic=${meetsBasicCriteria}, Liquidity=${hasGoodLiquidity}, Stable=${isStable}`);
                console.log(`  This item needs €${Math.abs(profitAmount + 1.0).toFixed(2)} less buy price to be profitable`);
            }
        }

        console.log(`[Backend] Analysis complete. Found ${analyzedItems.length} profitable items.`);
        
        res.json({ 
            analyzedItems,
            summary: {
                totalProcessed: items.length,
                profitableFound: analyzedItems.length,
                uniqueItemsChecked: uniqueNames.length,
                listingDataFound: Object.keys(allListingData).length,
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
