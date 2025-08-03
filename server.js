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
const SKINPORT_API_KEY = process.env.SKINPORT_API_KEY; // Add API key support
const APP_ID_CSGO = 730;
const SKINPORT_FEE = 0.08; // 8% seller fee

// Steam Community Market API (backup)
const STEAM_API_URL = 'https://steamcommunity.com/market/priceoverview';
const STEAM_FEE = 0.15; // 15% Steam fee

// CSFloat API (alternative backup)
const CSFLOAT_API_URL = 'https://csfloat.com/api/v1';

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
        
        // Create comma-separated list of market hash names (URLSearchParams will handle encoding)
        const marketHashNamesParam = validNames.join(',');
            
        const params = new URLSearchParams({
            app_id: APP_ID_CSGO,
            currency: currency,
            market_hash_name: marketHashNamesParam
        });
        
        const url = `${SKINPORT_API_URL}/sales/history?${params}`;
        console.log(`[API Call] Fetching batch of ${validNames.length} items`);
        console.log(`[API Call] Item names being queried:`, validNames.slice(0, 5));
        console.log(`[API Call] Full URL:`, url.substring(0, 200) + '...');
        console.log(`[API Call] Sample items being requested:`, validNames.slice(0, 3));
        console.log(`[API Call] Full URL:`, url);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept-Encoding': 'gzip, deflate, br',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
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
        console.log(`[API Response] Received ${Array.isArray(data) ? data.length : 'non-array'} items from API`);
        if (Array.isArray(data) && data.length > 0) {
            console.log(`[API Response] Sample API items:`, data.slice(0, 3).map(item => item.market_hash_name));
        }
        
        // Convert array response to object with market_hash_name as key
        const batchData = {};
        if (Array.isArray(data)) {
            data.forEach(item => {
                if (item.market_hash_name) {
                    batchData[item.market_hash_name] = item;
                }
            });
        }
        
        // Cache the batch response
        cache.set(batchKey, batchData);
        console.log(`[Cache] Batch cache set for ${marketHashNames.length} items`);
        
        return batchData;
        
    } catch (error) {
        console.error(`[Data Collection] Error fetching batch sales history: ${error.message}`);
        return {};
    }
}

/**
 * Fallback to Steam Community Market API when Skinport API fails
 */
async function fetchSteamMarketData(itemName) {
    try {
        const cacheKey = `steam_${itemName}`;
        const cachedData = cache.get(cacheKey);
        
        if (cachedData) {
            return cachedData;
        }

        const params = new URLSearchParams({
            appid: APP_ID_CSGO,
            currency: 3, // EUR
            market_hash_name: itemName
        });
        
        const url = `${STEAM_API_URL}?${params}`;
        console.log(`[Steam API] Fetching: ${itemName}`);
        
        const response = await fetch(url);
        
        if (!response.ok) {
            console.error(`[Steam API] Error ${response.status} for ${itemName}`);
            return null;
        }
        
        const data = await response.json();
        
        if (data.success) {
            // Convert Steam format to match our expected format
            const steamData = {
                market_hash_name: itemName,
                last_7_days: {
                    median: parseFloat(data.median_price?.replace(/[€$,]/g, '') || 0),
                    volume: data.volume ? parseInt(data.volume.replace(/,/g, '')) : 0,
                    min: parseFloat(data.lowest_price?.replace(/[€$,]/g, '') || 0),
                    max: parseFloat(data.median_price?.replace(/[€$,]/g, '') || 0) * 1.2 // Estimate
                },
                last_30_days: {
                    median: parseFloat(data.median_price?.replace(/[€$,]/g, '') || 0),
                    volume: data.volume ? parseInt(data.volume.replace(/,/g, '')) * 4 : 0 // Estimate
                }
            };
            
            // Cache for 10 minutes
            cache.set(cacheKey, steamData, 600);
            return steamData;
        }
        
        return null;
        
    } catch (error) {
        console.error(`[Steam API] Error fetching ${itemName}: ${error.message}`);
        return null;
    }
}

/**
 * Enhanced fetchSalesHistoryBatch with Steam API fallback
 */
async function fetchSalesHistoryBatchWithFallback(marketHashNames, currency) {
    // First try Skinport API
    const skinportData = await fetchSalesHistoryBatch(marketHashNames, currency);
    
    // If Skinport returns no data, try Steam API for each item
    if (Object.keys(skinportData).length === 0 && marketHashNames.length > 0) {
        console.log(`[Fallback] Skinport API returned no data, trying Steam API...`);
        
        const fallbackData = {};
        
        // Limit to first 5 items to avoid rate limiting
        for (const itemName of marketHashNames.slice(0, 5)) {
            const steamData = await fetchSteamMarketData(itemName);
            if (steamData) {
                fallbackData[itemName] = steamData;
            }
            // Small delay to avoid overwhelming Steam API
            await delay(200);
        }
        
        console.log(`[Fallback] Steam API returned ${Object.keys(fallbackData).length} items`);
        return fallbackData;
    }
    
    return skinportData;
}

/**
 * ADVANCED ANALYSIS FUNCTIONS
 */

/**
 * Analyzes price trends using median prices (more accurate than averages)
 */
function analyzePriceTrends(apiData) {
    const periods = {
        day1: apiData.last_24_hours,
        day7: apiData.last_7_days,
        day30: apiData.last_30_days,
        day90: apiData.last_90_days
    };
    
    // Use MEDIAN prices for more accurate trend analysis (filters outliers)
    const prices = [];
    const timeframes = [];
    
    if (periods.day1?.median) {
        prices.push(periods.day1.median);
        timeframes.push('24h');
    }
    if (periods.day7?.median) {
        prices.push(periods.day7.median);
        timeframes.push('7d');
    }
    if (periods.day30?.median) {
        prices.push(periods.day30.median);
        timeframes.push('30d');
    }
    if (periods.day90?.median) {
        prices.push(periods.day90.median);
        timeframes.push('90d');
    }
    
    if (prices.length === 0) return null;
    
    // Calculate trend
    let trend = 'stable';
    let trendStrength = 0;
    
    if (prices.length >= 2) {
        const recentPrice = prices[0]; // Most recent (24h or 7d)
        const longerTermPrice = prices[Math.min(2, prices.length - 1)]; // 30d if available
        const change = ((recentPrice - longerTermPrice) / longerTermPrice) * 100;
        
        trendStrength = Math.abs(change);
        
        if (change > 5) trend = 'rising';
        else if (change < -5) trend = 'falling';
        else trend = 'stable';
    }
    
    // Calculate confidence based on data availability and volume
    let confidence = 0;
    confidence += prices.length * 20; // 20 per timeframe
    
    if (periods.day7?.volume > 20) confidence += 20;
    else if (periods.day7?.volume > 10) confidence += 15;
    else if (periods.day7?.volume > 5) confidence += 10;
    
    if (periods.day30?.volume > 50) confidence += 15;
    if (periods.day1?.volume > 5) confidence += 15;
    
    confidence = Math.min(confidence, 100);
    
    return {
        prices: prices.map((p, i) => ({ period: timeframes[i], price: p })),
        trend,
        trendStrength: parseFloat(trendStrength.toFixed(2)),
        mostRecentPrice: prices[0],
        confidence
    };
}

/**
 * Assesses item liquidity based on sales frequency - more realistic thresholds
 */
function assessLiquidity(apiData) {
    const sales7d = apiData.last_7_days?.volume || 0;
    const sales30d = apiData.last_30_days?.volume || 0;
    const sales90d = apiData.last_90_days?.volume || 0;
    
    let liquidityRating;
    let sellTimeEstimate;
    
    // More realistic liquidity thresholds
    if (sales7d >= 15) {
        liquidityRating = 'GOOD';
        sellTimeEstimate = '1-3 days';
    } else if (sales7d >= 8) {
        liquidityRating = 'MEDIUM';
        sellTimeEstimate = '3-7 days';
    } else {
        liquidityRating = 'BAD';
        sellTimeEstimate = '1+ weeks';
    }
    
    // Calculate liquidity score with more reasonable thresholds
    let score = 0;
    
    // Base score from weekly sales
    if (sales7d >= 30) score += 80;
    else if (sales7d >= 15) score += 60;
    else if (sales7d >= 8) score += 40;
    else if (sales7d >= 5) score += 25;
    else score += 10;
    
    // Consistency bonus
    if (sales30d > 0) {
        const consistency = (sales7d * 4.3) / sales30d;
        if (consistency >= 0.8 && consistency <= 1.2) score += 15;
        else if (consistency > 1.2) score += 10;
        else score += 5;
    }
    
    // Volume bonus for long-term activity
    if (sales90d >= 200) score += 15;
    else if (sales90d >= 100) score += 10;
    else if (sales90d >= 50) score += 5;
    
    score = Math.min(Math.round(score), 100);
    
    return {
        rating: liquidityRating,
        score,
        sales7d,
        sales30d,
        sales90d,
        dailyAvg7d: parseFloat((sales7d / 7).toFixed(2)),
        sellTimeEstimate
    };
}

/**
 * Enhanced market timing analysis
 */
function analyzeMarketTiming(apiData) {
    const now = new Date();
    const hour = now.getHours();
    const dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday
    
    let marketActivity = 'NORMAL';
    let timingMultiplier = 1.0;
    
    // Peak trading hours (when most people are active)
    const isPeakHour = (hour >= 14 && hour <= 22) || (hour >= 9 && hour <= 12);
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    
    if (isPeakHour && !isWeekend) {
        marketActivity = 'PEAK';
        timingMultiplier = 1.05; // 5% higher prices during peak hours
    } else if (isWeekend) {
        marketActivity = 'WEEKEND';
        timingMultiplier = 0.98; // 2% lower prices on weekends
    } else if (hour >= 0 && hour <= 6) {
        marketActivity = 'LOW';
        timingMultiplier = 0.95; // 5% lower prices during low activity
    }
    
    return {
        marketActivity,
        timingMultiplier,
        isPeakHour,
        isWeekend,
        currentHour: hour,
        dayOfWeek
    };
}

/**
 * Supply and demand analysis
 */
function analyzeSupplyDemand(apiData) {
    const sales7d = apiData.last_7_days?.volume || 0;
    const sales30d = apiData.last_30_days?.volume || 0;
    const sales90d = apiData.last_90_days?.volume || 0;
    
    // Calculate demand trends
    const weeklyAvg = sales7d / 7;
    const monthlyAvg = sales30d / 30;
    const quarterlyAvg = sales90d / 90;
    
    let demandTrend = 'STABLE';
    let demandMultiplier = 1.0;
    
    // Compare recent vs long-term demand
    if (weeklyAvg > monthlyAvg * 1.2) {
        demandTrend = 'INCREASING';
        demandMultiplier = 1.03; // 3% higher prices due to increasing demand
    } else if (weeklyAvg < monthlyAvg * 0.8) {
        demandTrend = 'DECREASING';
        demandMultiplier = 0.97; // 3% lower prices due to decreasing demand
    }
    
    // Supply analysis based on price volatility
    const volatility7d = apiData.last_7_days ? 
        ((apiData.last_7_days.max - apiData.last_7_days.min) / apiData.last_7_days.median) * 100 : 0;
    
    let supplyStatus = 'NORMAL';
    if (volatility7d > 50) {
        supplyStatus = 'VOLATILE'; // High volatility suggests supply issues
    } else if (volatility7d < 10) {
        supplyStatus = 'STABLE'; // Low volatility suggests stable supply
    }
    
    return {
        demandTrend,
        demandMultiplier,
        supplyStatus,
        weeklyAvg: parseFloat(weeklyAvg.toFixed(2)),
        monthlyAvg: parseFloat(monthlyAvg.toFixed(2)),
        quarterlyAvg: parseFloat(quarterlyAvg.toFixed(2)),
        volatility7d: parseFloat(volatility7d.toFixed(2))
    };
}

/**
 * Enhanced comprehensive item analysis with realistic profit calculations
 */
function analyzeItemOpportunity(currentPrice, apiData, minProfit, minProfitMargin, settings = {}) {
    // Use enhanced profit calculation
    const enhancedProfit = calculateEnhancedProfit(currentPrice, apiData, settings);
    if (!enhancedProfit) {
        return null; // Skip items with insufficient data
    }
    
    const { predictedSellingPrice, netSellingPrice, profit, profitMargin, profitConfidence } = enhancedProfit;
    
    const trends = analyzePriceTrends(apiData);
    const liquidity = assessLiquidity(apiData);
    const marketTiming = analyzeMarketTiming(apiData);
    const supplyDemand = analyzeSupplyDemand(apiData);
    
    // Price volatility for risk assessment
    const volatility7d = apiData.last_7_days ? 
        ((apiData.last_7_days.max - apiData.last_7_days.min) / apiData.last_7_days.median) * 100 : 0;
    
    // Enhanced risk assessment with more factors
    let riskScore = 40; // Base risk
    
    // Volatility risk (more detailed) - using volatility7d from above
    
    if (volatility7d > 100) riskScore += 25;
    else if (volatility7d > 50) riskScore += 15;
    else if (volatility7d > 20) riskScore += 5;
    
    // Simplified liquidity risk - only GOOD or BAD
    if (liquidity.rating === 'GOOD') riskScore -= 20; // Much lower risk for good liquidity
    else riskScore += 30; // Much higher risk for bad liquidity
    
    // Trend risk (enhanced)
    if (trends.trend === 'falling' && trends.confidence > 60) riskScore += 20;
    else if (trends.trend === 'falling' && trends.confidence > 40) riskScore += 10;
    else if (trends.trend === 'rising' && trends.confidence > 60) riskScore -= 10;
    else if (trends.trend === 'rising' && trends.confidence > 40) riskScore -= 5;
    
    // Market timing risk (new)
    if (marketTiming.marketActivity === 'LOW') riskScore += 10;
    else if (marketTiming.marketActivity === 'PEAK') riskScore -= 5;
    
    // Supply/demand risk (new)
    if (supplyDemand.supplyStatus === 'VOLATILE') riskScore += 15;
    else if (supplyDemand.demandTrend === 'DECREASING') riskScore += 10;
    else if (supplyDemand.demandTrend === 'INCREASING') riskScore -= 5;
    
    // Profit margin risk (more nuanced)
    if (profitMargin > 100) riskScore += 30; // Suspiciously high
    else if (profitMargin > 50) riskScore += 15;
    else if (profitMargin > 30) riskScore += 5;
    else if (profitMargin < 3) riskScore += 10;
    
    // Price threshold risk (new)
    if (currentPrice < (settings.minPriceThreshold || 1.0)) {
        riskScore += 15; // Cheap items often have poor liquidity
    }
    
    // Sales volume risk (new)
    if (liquidity.sales7d < (settings.minSalesVolume || 5)) {
        riskScore += 20; // Low sales volume = higher risk
    }
    
    // Consistency risk (new)
    if (liquidity.sales30d > 0) {
        const consistency = (liquidity.sales7d * 4.3) / liquidity.sales30d;
        if (consistency < 0.5 || consistency > 2.0) riskScore += 10; // Inconsistent sales
    }
    
    riskScore = Math.max(5, Math.min(95, riskScore));
    
    // Determine risk level
    let riskLevel;
    if (riskScore <= 20) riskLevel = 'LOW';
    else if (riskScore <= 40) riskLevel = 'MEDIUM';
    else if (riskScore <= 60) riskLevel = 'HIGH';
    else riskLevel = 'VERY_HIGH';
    
    // Enhanced recommendation system
    let recommendation;
    let recommendationReason = [];
    
    if (profit <= 0) {
        recommendation = 'AVOID';
        recommendationReason.push('No profit after fees');
    } else if (riskScore > 80) {
        recommendation = 'AVOID';
        recommendationReason.push('Too risky');
    } else if (liquidity.rating === 'BAD') {
        recommendation = 'AVOID';
        recommendationReason.push('Poor liquidity');
    } else if (profitMargin >= 20 && liquidity.score >= 60 && riskScore <= 30) {
        recommendation = 'STRONG BUY';
        recommendationReason.push('High profit, good liquidity, low risk');
    } else if (profitMargin >= 15 && liquidity.score >= 45 && riskScore <= 40) {
        recommendation = 'BUY';
        recommendationReason.push('Good profit with acceptable risk');
    } else if (profitMargin >= 10 && liquidity.score >= 30 && riskScore <= 50) {
        recommendation = 'CONSIDER';
        recommendationReason.push('Moderate opportunity');
    } else if (profitMargin >= 5 && liquidity.score >= 20 && riskScore <= 60) {
        recommendation = 'WEAK BUY';
        recommendationReason.push('Low profit but manageable risk');
    } else {
        recommendation = 'AVOID';
        recommendationReason.push('Unfavorable risk/reward ratio');
    }
    
    // Apply user filters with more lenient approach
    console.log(`[Filter] Item analysis: Profit=€${profit.toFixed(2)}, Margin=${profitMargin.toFixed(1)}%, Liquidity=${liquidity.rating}, Sales7d=${liquidity.sales7d}`);
    console.log(`[Filter] User settings: minProfit=€${minProfit}, minProfitMargin=${minProfitMargin}%, minLiquidity=${settings.minLiquidity}, minSalesVolume=${settings.minSalesVolume}`);
    
    // Use user settings directly - trust the user's judgment
    const actualMinProfit = minProfit || 0;
    const actualMinMargin = minProfitMargin || 0;
    
    if (profit < actualMinProfit || profitMargin < actualMinMargin) {
        console.log(`[Filter] REJECTED: Profit/margin below threshold (Profit: €${profit.toFixed(2)} < €${actualMinProfit}, Margin: ${profitMargin.toFixed(1)}% < ${actualMinMargin}%)`);
        return null; // Doesn't meet criteria
    }
    
    // Much more lenient liquidity filtering - only reject if liquidity is really bad
    if (settings.minLiquidity && settings.minLiquidity === 'GOOD' && liquidity.rating !== 'GOOD') {
        console.log(`[Filter] REJECTED: Liquidity requirement not met (${liquidity.rating} < GOOD)`);
        return null; // Doesn't meet liquidity requirements
    }
    
    // Use user's sales volume preference directly
    const actualMinSales = settings.minSalesVolume || 5;
    
    if (liquidity.sales7d < actualMinSales) {
        console.log(`[Filter] REJECTED: Sales volume too low (${liquidity.sales7d} < ${actualMinSales})`);
        return null; // Doesn't meet sales volume requirements
    }
    
    console.log(`[Filter] ACCEPTED: Item meets all criteria`);
    
    return {
        currentPrice,
        predictedSellingPrice: parseFloat(predictedSellingPrice.toFixed(2)),
        netSellingPrice: parseFloat(netSellingPrice.toFixed(2)),
        profit: parseFloat(profit.toFixed(2)),
        profitMargin: parseFloat(profitMargin.toFixed(2)),
        profitConfidence,
        trends,
        liquidity,
        marketTiming,
        supplyDemand,
        riskScore,
        riskLevel,
        recommendation,
        recommendationReason: recommendationReason.join(', '),
        volatility7d: parseFloat(volatility7d.toFixed(2)),
        feeAmount: parseFloat((predictedSellingPrice * SKINPORT_FEE).toFixed(2)),
        netProfitAfterFees: parseFloat(profit.toFixed(2)),
        enhancedFactors: enhancedProfit.factors
    };
}

/**
 * Computes an achievable selling price based on market data
 */
function computeAchievablePrice(apiData) {
    const m24 = apiData.last_24_hours?.median;
    const v24 = apiData.last_24_hours?.volume || 0;
    const m7 = apiData.last_7_days?.median;
    const v7 = apiData.last_7_days?.volume || 0;
    const m30 = apiData.last_30_days?.median;

    // 1) Base median selection
    let baseMedian = null;
    if (m24 && v24 >= 5) baseMedian = m24;
    else if (m7 && v7 >= 15) baseMedian = m7;
    else baseMedian = m24 || m7 || m30;

    if (!baseMedian) return null;

    // 2) Trend factor based on 24h vs 7d
    let trendFactor = 1.00;
    if (m24 && m7) {
        const change = (m24 - m7) / m7;
        if (change <= -0.05) trendFactor = 0.98;
        else if (change >= 0.05) trendFactor = 1.02;
    }

    // 3) Liquidity factor based on 7d sales
    let liquidityFactor = 1.00;
    if (v7 >= 40) liquidityFactor = 1.00;
    else if (v7 >= 15) liquidityFactor = 0.99;
    else liquidityFactor = 0.97;

    // 4) Volatility factor
    const vol7 = apiData.last_7_days ? 
        ((apiData.last_7_days.max - apiData.last_7_days.min) / apiData.last_7_days.median) : 0;
    let volatilityFactor = 1.00;
    if (vol7 > 0.50) volatilityFactor = 0.97;
    else if (vol7 > 0.30) volatilityFactor = 0.99;

    // 5) Undercut pressure from recent vs longer-term prices
    let undercutFactor = 1.00;
    if (m24 && m30 && (m24 < m30 * 0.95)) undercutFactor = 0.98;

    // 6) Calculate achievable price with adaptive sell underprice
    let sellUnderprice = 0.995; // Default to 0.5% below market
    if (m24 && m7) {
        const dip = (m24 - m7) / m7;
        if (dip <= -0.06) sellUnderprice = 0.985; // Deeper discount for strong downtrend
        else if (dip <= -0.02) sellUnderprice = 0.99; // Moderate discount for slight downtrend
    }
    
    const rawPredicted = baseMedian * trendFactor * liquidityFactor * volatilityFactor * undercutFactor;
    const achievablePrice = rawPredicted * sellUnderprice;

    return {
        achievablePrice,
        baseMedian,
        factors: {
            trendFactor,
            liquidityFactor,
            volatilityFactor,
            undercutFactor,
            sellUnderprice
        },
        metrics: {
            vol7,
            v7,
            v24,
            m24,
            m7,
            m30
        }
    };
}

// Simplified and more realistic profit calculation strategy
function calculateEnhancedProfit(currentPrice, apiData, settings = {}) {
    const priceData = computeAchievablePrice(apiData);
    if (!priceData) {
        console.log(`[Filter] REJECTED: No price data available for €${currentPrice} item`);
        return null;
    }

    const { achievablePrice, metrics, factors } = priceData;
    const { vol7, v7, v24 } = metrics;
    
    // Much more lenient sales volume requirements
    const minSalesForPrice = currentPrice < 5 ? 5 :    // Very cheap items need 5 sales
                            currentPrice < 20 ? 8 :    // Low-mid items need 8 sales  
                            currentPrice < 100 ? 10 :  // Mid items need 10 sales
                            12;                         // Expensive items need 12 sales
    
    if (v7 < minSalesForPrice) {
        console.log(`[Filter] REJECTED: Insufficient sales volume (${v7} < ${minSalesForPrice}) for €${currentPrice} item`);
        return null;
    }

    // Apply realistic costs and fees
    const buySlippage = 1.002; // 0.2% execution friction (reduced)
    const effectiveCost = currentPrice * buySlippage;
    const netSellingPrice = achievablePrice * 0.92; // After 8% fee
    const profit = netSellingPrice - effectiveCost;
    const profitMargin = (profit / effectiveCost) * 100;

    // Much more relaxed profit requirements based on price tiers
    const minProfitForPrice = currentPrice < 5 ? 0.50 :    // €0.50 for very cheap items
                             currentPrice < 20 ? 1.50 :    // €1.50 for low-mid items
                             currentPrice < 100 ? 3.00 :   // €3.00 for mid items  
                             5.00;                          // €5.00 for expensive items
    
    const minMarginForPrice = currentPrice < 5 ? 5 :       // 5% for very cheap items
                             currentPrice < 20 ? 8 :       // 8% for low-mid items
                             currentPrice < 100 ? 10 :     // 10% for mid items
                             12;                            // 12% for expensive items

    // Use user settings if they're lower than our defaults (more permissive)
    const actualMinProfit = Math.min(settings.minProfit || minProfitForPrice, minProfitForPrice);
    const actualMinMargin = Math.min(settings.minProfitMargin || minMarginForPrice, minMarginForPrice);
    
    if (profit < actualMinProfit || profitMargin < actualMinMargin) {
        console.log(`[Filter] REJECTED: Profit/margin too low (Profit: €${profit.toFixed(2)} < €${actualMinProfit}, Margin: ${profitMargin.toFixed(1)}% < ${actualMinMargin}%) for €${currentPrice} item`);
        return null;
    }

    // Much more lenient volatility check (allow up to 100% volatility)
    const maxVolatility = 1.0; // 100% volatility allowed
    if (vol7 > maxVolatility) {
        console.log(`[Filter] REJECTED: Too volatile (${(vol7*100).toFixed(1)}% > ${maxVolatility*100}%) for €${currentPrice} item`);
        return null;
    }

    // Calculate realistic confidence score
    let profitConfidence = 40; // Lower base confidence

    // Volume-based confidence (more lenient)
    if (v7 >= 30) profitConfidence += 25;
    else if (v7 >= 15) profitConfidence += 15;
    else if (v7 >= 8) profitConfidence += 10;

    // Volatility confidence (more lenient)
    if (vol7 <= 0.3) profitConfidence += 15;
    else if (vol7 <= 0.6) profitConfidence += 5;

    // Recent activity confidence
    if (metrics.m24 && v24 >= 5) profitConfidence += 10;
    
    profitConfidence = Math.max(20, Math.min(85, profitConfidence));
    
    console.log(`[Filter] ACCEPTED: €${currentPrice} item - Profit: €${profit.toFixed(2)} (${profitMargin.toFixed(1)}%), Sales: ${v7}, Confidence: ${profitConfidence}%`);
    
    return {
        currentPrice,
        achievablePrice: parseFloat(achievablePrice.toFixed(2)),
        netSellingPrice: parseFloat(netSellingPrice.toFixed(2)),
        effectiveCost: parseFloat(effectiveCost.toFixed(2)),
        profit: parseFloat(profit.toFixed(2)),
        profitMargin: parseFloat(profitMargin.toFixed(2)),
        profitConfidence,
        feeAmount: parseFloat((achievablePrice * 0.08).toFixed(2)),
        buySlippage: parseFloat((currentPrice * 0.002).toFixed(2)),
        metrics: {
            volatility7d: parseFloat(vol7.toFixed(3)),
            sales7d: v7,
            sales24h: v24,
            consistency: apiData.last_30_days?.volume > 0 ? parseFloat(((v7 * 4.3) / apiData.last_30_days.volume).toFixed(2)) : null
        },
        factors: priceData.factors,
        baseMedian: priceData.baseMedian
    };
}

/**
 * UPDATED MAIN ANALYSIS FUNCTION
 */
async function analyzePrices(items, minProfit, minProfitMargin, currency, settings = {}) {
    const analyzedItems = [];
    const uniqueItems = [...new Set(items.map(item => item.marketHashName))];
    
    console.log(`[Analysis] Processing ${uniqueItems.length} unique items with REALISTIC analysis...`);
    console.log(`[Analysis] Settings: minProfit=€${minProfit}, minMargin=${minProfitMargin}%, currency=${currency}`);
    console.log(`[Analysis] First few items:`, items.slice(0, 3).map(item => `${item.marketHashName} €${item.price}`));
    
    // Create optimal batches
    const batches = createOptimalBatches(uniqueItems);
    
    if (batches.length > MAX_REQUESTS_PER_WINDOW) {
        console.warn(`[Analysis] Warning: ${batches.length} batches exceed rate limit of ${MAX_REQUESTS_PER_WINDOW} requests per 5 minutes`);
        console.warn(`[Analysis] Processing first ${MAX_REQUESTS_PER_WINDOW} batches only`);
    }
    
    const batchesToProcess = batches.slice(0, MAX_REQUESTS_PER_WINDOW);
    
    for (let i = 0; i < batchesToProcess.length; i++) {
        const batch = batchesToProcess[i];
        console.log(`[Analysis] Processing batch ${i + 1}/${batchesToProcess.length} (${batch.length} items)`);
        
        const batchSalesHistory = await fetchSalesHistoryBatch(batch, currency);
        
        console.log(`[Analysis] Batch ${i + 1} returned data for ${Object.keys(batchSalesHistory).length} items`);
        if (Object.keys(batchSalesHistory).length > 0) {
            console.log(`[Analysis] Sample API response keys:`, Object.keys(batchSalesHistory).slice(0, 3));
        }
        if (Object.keys(batchSalesHistory).length > 0) {
            console.log(`[Analysis] API returned items:`, Object.keys(batchSalesHistory).slice(0, 3));
        }
        console.log(`[Analysis] Requested items:`, batch.slice(0, 3));
        
        // Process each item in the batch
        for (const marketHashName of batch) {
            const apiData = batchSalesHistory[marketHashName];
            
            if (apiData) {
                console.log(`[Analysis] Processing ${marketHashName}: 7d sales=${apiData.last_7_days?.volume || 0}, 7d median=€${apiData.last_7_days?.median || 'N/A'}`);
                
                const marketItems = items.filter(item => item.marketHashName === marketHashName);
                
                for (const { price, wear } of marketItems) {
                    console.log(`[Analysis] Analyzing ${marketHashName} (${wear}) at €${price}`);
                    const analysis = analyzeItemOpportunity(price, apiData, minProfit, minProfitMargin, settings);
                    
                    if (analysis) {
                        console.log(`[Analysis] ✅ FOUND DEAL: ${marketHashName} - Profit: €${analysis.profit}, Margin: ${analysis.profitMargin}%`);
                        analyzedItems.push({
                            marketHashName,
                            wear,
                            ...analysis
                        });
                    } else {
                        console.log(`[Analysis] ❌ Rejected: ${marketHashName} (${wear}) at €${price}`);
                    }
                }
            } else {
                console.log(`[Analysis] No API data for: ${marketHashName}`);
            }
        }
    }
    
    // Sort by profit margin descending
    analyzedItems.sort((a, b) => b.profitMargin - a.profitMargin);
    
    console.log(`[Analysis] FINAL RESULT: Found ${analyzedItems.length} profitable deals using REALISTIC analysis`);
    if (analyzedItems.length > 0) {
        console.log(`[Analysis] Top deal: ${analyzedItems[0].marketHashName} - ${analyzedItems[0].profitMargin.toFixed(2)}% margin`);
    }
    
    return analyzedItems;
}

// API endpoint to receive prices and return deals
app.post('/analyze-prices', async (req, res) => {
    const { items, settings } = req.body;
    if (!items || !Array.isArray(items) || !settings) {
        return res.status(400).json({ error: 'Invalid input. Expected an array of items and settings.' });
    }

    console.log(`[Backend] Received ${items.length} items for ENHANCED analysis.`);

    try {
        const analyzedItems = await analyzePrices(
            items, 
            settings.minProfit, 
            settings.minProfitMargin, 
            settings.currency,
            settings
        );
        res.json({ 
            analyzedItems,
            summary: {
                totalProcessed: items.length,
                profitableFound: analyzedItems.length,
                analysisType: 'ENHANCED',
                includedFactors: ['price_trends', 'liquidity', 'volatility', 'risk_assessment', 'fee_calculation', 'user_filters', 'market_timing', 'supply_demand']
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

// Debug endpoint to test specific item names
app.get('/debug-item/:itemName', async (req, res) => {
    try {
        const itemName = decodeURIComponent(req.params.itemName);
        console.log(`[Debug] Testing item name: "${itemName}"`);
        
        const result = await fetchSalesHistoryBatch([itemName], 'EUR');
        
        res.json({
            requestedName: itemName,
            foundInAPI: !!result[itemName],
            apiResponse: result[itemName] || null,
            allReturnedNames: Object.keys(result)
        });
    } catch (error) {
        console.error('[Debug] Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Start Express server
app.listen(port, () => {
    console.log(`Enhanced Skinport Tracker API listening on port ${port}`);
    console.log(`Using MEDIAN prices and comprehensive risk analysis with user filters`);
}); 