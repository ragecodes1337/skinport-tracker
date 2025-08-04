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
const MINIMUM_PROFIT_THRESHOLD = 0.12; // Minimum €0.12 profit (optimized for capturing more small opportunities)

// Rate limiting configuration - Skinport allows 8 requests per 5 minutes
const RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes in milliseconds
const MAX_REQUESTS_PER_WINDOW = 8; // Use full allowance of 8 requests per 5 minutes
const requestQueue = []; // Queue to store timestamps of requests

// Middleware
app.use(cors());
app.use(express.json());

/**
 * Normalize item names for consistent matching between server and content script
 */
function normalizeItemName(name) {
    if (!name) return null;
    
    return name.trim()
        // Normalize StatTrak symbol
        .replace(/StatTrak™?/g, 'StatTrak™')
        // Normalize knife star symbol
        .replace(/★/g, '★')
        // Normalize spaces
        .replace(/\s+/g, ' ')
        // Remove any trailing/leading spaces
        .trim();
}

/**
 * Enhanced Float Value Intelligence - Parse, estimate, and categorize float values for realistic pricing
 */
function analyzeFloatValue(itemName, currentPrice, marketData = null) {
    // Extract float value from item name (if present)
    const floatMatch = itemName.match(/(\d+\.\d+)/);
    const hasExplicitFloat = floatMatch !== null;
    const explicitFloatValue = hasExplicitFloat ? parseFloat(floatMatch[1]) : null;
    
    // Determine wear condition from item name
    let wearCondition = 'UNKNOWN';
    if (itemName.includes('Factory New')) wearCondition = 'FN';
    else if (itemName.includes('Minimal Wear')) wearCondition = 'MW';
    else if (itemName.includes('Field-Tested')) wearCondition = 'FT';
    else if (itemName.includes('Well-Worn')) wearCondition = 'WW';
    else if (itemName.includes('Battle-Scarred')) wearCondition = 'BS';
    
    // If no explicit float but we have wear condition and market data, estimate float tier
    if (!hasExplicitFloat && wearCondition !== 'UNKNOWN' && marketData) {
        const estimatedFloatAnalysis = estimateFloatFromMarketPosition(currentPrice, marketData, wearCondition);
        return {
            hasFloat: false,
            floatValue: null,
            floatTier: estimatedFloatAnalysis.estimatedTier,
            floatMultiplier: estimatedFloatAnalysis.multiplier,
            floatAnalysis: estimatedFloatAnalysis.reasoning,
            wearCondition: wearCondition,
            isEstimated: true,
            confidence: estimatedFloatAnalysis.confidence
        };
    }
    
    if (!hasExplicitFloat) {
        return {
            hasFloat: false,
            floatValue: null,
            floatTier: 'UNKNOWN',
            floatMultiplier: 1.0,
            floatAnalysis: 'No float value detected in item name',
            wearCondition: wearCondition,
            isEstimated: false,
            confidence: 'NONE'
        };
    }
    
    // Define float ranges for each wear condition
    const floatRanges = {
        'FN': { min: 0.00, max: 0.07, optimal: 0.00, premium: 0.01 },
        'MW': { min: 0.07, max: 0.15, optimal: 0.07, premium: 0.08 },
        'FT': { min: 0.15, max: 0.38, optimal: 0.15, premium: 0.20 },
        'WW': { min: 0.38, max: 0.45, optimal: 0.38, premium: 0.40 },
        'BS': { min: 0.45, max: 1.00, optimal: 0.45, premium: 0.50 }
    };
    
    if (wearCondition === 'UNKNOWN') {
        return {
            hasFloat: true,
            floatValue: explicitFloatValue,
            floatTier: 'UNKNOWN_WEAR',
            floatMultiplier: 1.0,
            floatAnalysis: `Float ${explicitFloatValue} detected but wear condition unknown`,
            wearCondition: wearCondition,
            isEstimated: false,
            confidence: 'LOW'
        };
    }
    
    const ranges = floatRanges[wearCondition];
    
    // Validate float value is within wear condition range
    if (explicitFloatValue < ranges.min || explicitFloatValue > ranges.max) {
        return {
            hasFloat: true,
            floatValue: explicitFloatValue,
            floatTier: 'INVALID_RANGE',
            floatMultiplier: 1.0,
            floatAnalysis: `Float ${explicitFloatValue} outside ${wearCondition} range (${ranges.min}-${ranges.max})`,
            wearCondition: wearCondition,
            isEstimated: false,
            confidence: 'ERROR'
        };
    }
    
    // Calculate float percentile within wear range
    const range = ranges.max - ranges.min;
    const floatPosition = (explicitFloatValue - ranges.min) / range;
    
    // Determine float tier and pricing multiplier with market awareness - ENHANCED GRANULARITY
    let floatTier, floatMultiplier, floatAnalysis;
    
    if (explicitFloatValue <= ranges.premium) {
        // Premium float (top tier within wear condition)
        floatTier = 'PREMIUM';
        floatMultiplier = getConservativeFloatMultiplier(wearCondition, 'PREMIUM');
        floatAnalysis = `Premium ${wearCondition} float (${explicitFloatValue}) - conservative ${((floatMultiplier - 1) * 100).toFixed(0)}% adjustment`;
    } else if (floatPosition <= 0.15) {
        // Excellent float (top 15% of wear range) - NEW TIER
        floatTier = 'EXCELLENT';
        floatMultiplier = getConservativeFloatMultiplier(wearCondition, 'EXCELLENT');
        floatAnalysis = `Excellent ${wearCondition} float (${explicitFloatValue}) - granular ${((floatMultiplier - 1) * 100).toFixed(0)}% adjustment`;
    } else if (floatPosition <= 0.3) {
        // Good float (bottom 30% of wear range)
        floatTier = 'GOOD';
        floatMultiplier = getConservativeFloatMultiplier(wearCondition, 'GOOD');
        floatAnalysis = `Good ${wearCondition} float (${explicitFloatValue}) - conservative ${((floatMultiplier - 1) * 100).toFixed(0)}% adjustment`;
    } else if (floatPosition <= 0.5) {
        // Average-Good float (30-50% range) - NEW TIER
        floatTier = 'AVERAGE_GOOD';
        floatMultiplier = getConservativeFloatMultiplier(wearCondition, 'AVERAGE_GOOD');
        floatAnalysis = `Above-average ${wearCondition} float (${explicitFloatValue}) - slight ${((floatMultiplier - 1) * 100).toFixed(0)}% adjustment`;
    } else if (floatPosition <= 0.7) {
        // Average float (middle 20% of wear range)
        floatTier = 'AVERAGE';
        floatMultiplier = 1.0;
        floatAnalysis = `Average ${wearCondition} float (${explicitFloatValue}) - standard pricing`;
    } else if (floatPosition <= 0.85) {
        // Below-Average float (70-85% range) - NEW TIER
        floatTier = 'BELOW_AVERAGE';
        floatMultiplier = getConservativeFloatMultiplier(wearCondition, 'BELOW_AVERAGE');
        floatAnalysis = `Below-average ${wearCondition} float (${explicitFloatValue}) - minor ${((1 - floatMultiplier) * 100).toFixed(0)}% discount`;
    } else {
        // Poor float (top 15% of wear range)
        floatTier = 'POOR';
        floatMultiplier = getConservativeFloatMultiplier(wearCondition, 'POOR');
        floatAnalysis = `Poor ${wearCondition} float (${explicitFloatValue}) - conservative ${((1 - floatMultiplier) * 100).toFixed(0)}% discount`;
    }
    
    return {
        hasFloat: true,
        floatValue: explicitFloatValue,
        wearCondition: wearCondition,
        floatTier: floatTier,
        floatMultiplier: floatMultiplier,
        floatPosition: floatPosition,
        floatAnalysis: floatAnalysis,
        floatRanges: ranges,
        isEstimated: false,
        confidence: 'HIGH'
    };
}

/**
 * Enhanced granular float multipliers for better within-wear-range pricing
 */
function getConservativeFloatMultiplier(wearCondition, floatTier) {
    const multipliers = {
        'PREMIUM': {
            'FN': 1.08, 'MW': 1.06, 'FT': 1.05, 'WW': 1.03, 'BS': 1.02
        },
        'EXCELLENT': {
            'FN': 1.05, 'MW': 1.04, 'FT': 1.03, 'WW': 1.02, 'BS': 1.015
        },
        'GOOD': {
            'FN': 1.04, 'MW': 1.03, 'FT': 1.02, 'WW': 1.015, 'BS': 1.01
        },
        'AVERAGE_GOOD': {
            'FN': 1.02, 'MW': 1.015, 'FT': 1.01, 'WW': 1.005, 'BS': 1.005
        },
        'BELOW_AVERAGE': {
            'FN': 0.98, 'MW': 0.985, 'FT': 0.99, 'WW': 0.995, 'BS': 0.995
        },
        'POOR': {
            'FN': 0.96, 'MW': 0.97, 'FT': 0.98, 'WW': 0.985, 'BS': 0.99
        }
    };
    
    return multipliers[floatTier]?.[wearCondition] || 1.0;
}

/**
 * Estimate float tier from market position when explicit float not available
 */
function estimateFloatFromMarketPosition(currentPrice, marketData, wearCondition) {
    const medianPrice = marketData.median_price || marketData.median;
    const minPrice = marketData.min_price || marketData.min;
    const maxPrice = marketData.max_price || marketData.max;
    
    if (!medianPrice || !minPrice || !maxPrice) {
        return {
            estimatedTier: 'UNKNOWN',
            multiplier: 1.0,
            reasoning: 'Insufficient market data for float estimation',
            confidence: 'NONE'
        };
    }
    
    // Calculate price position within market range
    const priceRange = maxPrice - minPrice;
    const pricePosition = priceRange > 0 ? (currentPrice - minPrice) / priceRange : 0.5;
    
    let estimatedTier, multiplier, reasoning, confidence;
    
    if (pricePosition >= 0.8) {
        // Top 20% of price range - likely premium float
        estimatedTier = 'PREMIUM_ESTIMATED';
        multiplier = getConservativeFloatMultiplier(wearCondition, 'PREMIUM') * 0.7; // More conservative for estimates
        reasoning = `Estimated premium float based on price position (top 20% of market range)`;
        confidence = 'MEDIUM';
    } else if (pricePosition >= 0.6) {
        // Top 40% of price range - likely good float
        estimatedTier = 'GOOD_ESTIMATED';
        multiplier = getConservativeFloatMultiplier(wearCondition, 'GOOD') * 0.8; // More conservative for estimates
        reasoning = `Estimated good float based on price position (top 40% of market range)`;
        confidence = 'MEDIUM';
    } else if (pricePosition <= 0.2) {
        // Bottom 20% of price range - likely poor float
        estimatedTier = 'POOR_ESTIMATED';
        multiplier = getConservativeFloatMultiplier(wearCondition, 'POOR') * 1.2; // Larger discount for estimates
        reasoning = `Estimated poor float based on price position (bottom 20% of market range)`;
        confidence = 'MEDIUM';
    } else {
        // Middle range - assume average float
        estimatedTier = 'AVERAGE_ESTIMATED';
        multiplier = 1.0;
        reasoning = `Estimated average float based on price position (middle of market range)`;
        confidence = 'LOW';
    }
    
    return { estimatedTier, multiplier, reasoning, confidence };
}

/**
 * Multi-timeframe analysis with RECENT-FIRST priority for accurate market pricing
 */
function analyzeMultiTimeframe(salesData) {
    const timeframes = [];
    
    // Check all available timeframes
    if (salesData.last_24_hours && salesData.last_24_hours.volume > 0) {
        timeframes.push({
            period: '24h',
            data: salesData.last_24_hours,
            weight: 10, // MUCH higher weight for recent data
            recency: 1,
            priorityTier: 1 // Highest priority
        });
    }
    
    if (salesData.last_7_days && salesData.last_7_days.volume > 0) {
        timeframes.push({
            period: '7d',
            data: salesData.last_7_days,
            weight: 8, // High weight for weekly data
            recency: 2,
            priorityTier: 1 // Highest priority
        });
    }
    
    if (salesData.last_30_days && salesData.last_30_days.volume > 0) {
        timeframes.push({
            period: '30d',
            data: salesData.last_30_days,
            weight: 4, // Lower weight for monthly
            recency: 3,
            priorityTier: 2 // Medium priority - fallback only
        });
    }
    
    if (salesData.last_90_days && salesData.last_90_days.volume > 0) {
        timeframes.push({
            period: '90d',
            data: salesData.last_90_days,
            weight: 1, // Very low weight for quarterly
            recency: 4,
            priorityTier: 3 // Low priority - trend analysis only
        });
    }
    
    if (timeframes.length === 0) {
        return null;
    }
    
    // REALISTIC TIMEFRAME Selection Logic - Focus on 7d data for better market reality:
    // 1. Prefer 7d data if volume >= 1 (realistic weekly pattern)
    // 2. Use 24h if volume >= 3 AND no 7d data (strong daily activity)
    // 3. Use 30d if volume >= 5 (monthly sample as fallback)
    // 4. Use 90d as last resort if volume >= 8 (quarterly trend)
    
    let bestTimeframe;
    
    // PRIORITY: 7d data with ANY meaningful activity (realistic approach)
    const tf7d = timeframes.find(t => t.period === '7d');
    if (tf7d && tf7d.data.volume >= 1) {
        bestTimeframe = tf7d;
        console.log(`[Timeframe Selection] Using 7d data: ${tf7d.data.volume} sales, €${(tf7d.data.median || tf7d.data.avg).toFixed(2)} median - WEEKLY REALITY`);
    }
    // Second choice: 24h with decent volume (only if no 7d data)
    else {
        const tf24h = timeframes.find(t => t.period === '24h');
        if (tf24h && tf24h.data.volume >= 3) {
            bestTimeframe = tf24h;
            console.log(`[Timeframe Selection] Using 24h data: ${tf24h.data.volume} sales, €${(tf24h.data.median || tf24h.data.avg).toFixed(2)} median - DAILY ACTIVITY`);
        }
        // Third choice: 30d with some volume
        else {
            const tf30d = timeframes.find(t => t.period === '30d');
            if (tf30d && tf30d.data.volume >= 5) {
                bestTimeframe = tf30d;
                console.log(`[Timeframe Selection] Using 30d data: ${tf30d.data.volume} sales, €${(tf30d.data.median || tf30d.data.avg).toFixed(2)} median - MONTHLY SAMPLE`);
            }
            // Fourth choice: 90d with reasonable volume
            else {
                const tf90d = timeframes.find(t => t.period === '90d');
                if (tf90d && tf90d.data.volume >= 8) {
                    bestTimeframe = tf90d;
                    console.log(`[Timeframe Selection] Using 90d data: ${tf90d.data.volume} sales, €${(tf90d.data.median || tf90d.data.avg).toFixed(2)} median - QUARTERLY TREND`);
                }
                // Last resort: Best available with WARNING
                else {
                    bestTimeframe = timeframes.reduce((best, current) => {
                        return current.data.volume > best.data.volume ? current : best;
                    });
                    console.log(`[TIMEFRAME WARNING] Using ${bestTimeframe.period} data with LOW VOLUME: ${bestTimeframe.data.volume} sales - PROCEED WITH CAUTION`);
                }
            }
        }
    }
    
    // REALISTIC: Accept items with minimal market data (1+ sales)
    if (!bestTimeframe || bestTimeframe.data.volume < 1) {
        console.log(`[INSUFFICIENT DATA REJECTION] Item has ${bestTimeframe?.data.volume || 0} sales in best timeframe - NO MARKET DATA`);
        return null; // Signal to calling function that this item should be skipped
    }
    
    // Detect price trend using recent vs older data - using median prices for better stability
    let trend = 'STABLE';
    const recent24h = timeframes.find(t => t.period === '24h');
    const recent7d = timeframes.find(t => t.period === '7d');
    const older30d = timeframes.find(t => t.period === '30d');
    
    if (recent24h && recent7d) {
        const recent24hMedian = recent24h.data.median || recent24h.data.avg;
        const recent7dMedian = recent7d.data.median || recent7d.data.avg;
        const priceChange = ((recent24hMedian - recent7dMedian) / recent7dMedian) * 100;
        if (priceChange > 8) trend = 'RISING';
        else if (priceChange < -8) trend = 'FALLING';
    } else if (recent7d && older30d) {
        const recent7dMedian = recent7d.data.median || recent7d.data.avg;
        const older30dMedian = older30d.data.median || older30d.data.avg;
        const priceChange = ((recent7dMedian - older30dMedian) / older30dMedian) * 100;
        if (priceChange > 10) trend = 'RISING';
        else if (priceChange < -10) trend = 'FALLING';
    }
    
    return {
        bestTimeframe,
        allTimeframes: timeframes,
        trend,
        confidence: timeframes.length >= 2 ? 'HIGH' : timeframes.length === 1 ? 'MEDIUM' : 'LOW',
        recentDataQuality: recent24h ? 'EXCELLENT' : recent7d ? 'GOOD' : 'LIMITED'
    };
}

/**
 * CHEAPEST TRADEABLE Gap Analysis - Analyze the gap between buy price and cheapest tradeable
 */
function analyzeCheapestTradeableGap(buyPrice, cheapestTradeable) {
    const gap = cheapestTradeable - buyPrice;
    const gapPercentage = (gap / buyPrice) * 100;
    
    let gapCategory, strategy, description;
    
    if (gapPercentage >= 50) {
        gapCategory = 'HUGE_GAP';
        strategy = 'AGGRESSIVE_UNDERCUT';
        description = `Huge ${gapPercentage.toFixed(1)}% gap - can undercut aggressively`;
    } else if (gapPercentage >= 25) {
        gapCategory = 'LARGE_GAP';
        strategy = 'MODERATE_UNDERCUT';
        description = `Large ${gapPercentage.toFixed(1)}% gap - moderate undercut recommended`;
    } else if (gapPercentage >= 10) {
        gapCategory = 'MEDIUM_GAP';
        strategy = 'SMALL_UNDERCUT';
        description = `Medium ${gapPercentage.toFixed(1)}% gap - small undercut or competitive pricing`;
    } else if (gapPercentage >= 3) {
        gapCategory = 'SMALL_GAP';
        strategy = 'MINIMAL_UNDERCUT';
        description = `Small ${gapPercentage.toFixed(1)}% gap - minimal undercut, rely on market position`;
    } else {
        gapCategory = 'TINY_GAP';
        strategy = 'MATCH_OR_SLIGHT_UNDER';
        description = `Tiny ${gapPercentage.toFixed(1)}% gap - match cheapest or slight undercut`;
    }
    
    return {
        gap: gap,
        gapPercentage: gapPercentage,
        gapCategory: gapCategory,
        strategy: strategy,
        description: description
    };
}

/**
 * SALES-ONLY Smart pricing calculation with CHEAPEST TRADEABLE integration
 */
function calculateSmartAchievablePrice(buyPrice, marketData, multiTimeframeData, currentMinPrice, floatAnalysis = null) {
    if (!multiTimeframeData || !multiTimeframeData.bestTimeframe) {
        // Fallback to conservative sales-based pricing
        const recent7dData = multiTimeframeData?.allTimeframes?.find(t => t.period === '7d');
        if (recent7dData) {
            const conservativePrice = (recent7dData.data.median || recent7dData.data.avg) * 0.90;
            return {
                achievablePrice: conservativePrice,
                confidence: 'LOW',
                strategy: 'FALLBACK_SALES_CONSERVATIVE',
                reasoning: 'Limited sales data, using conservative 7d median * 0.90'
            };
        }
        
        return {
            achievablePrice: 0,
            confidence: 'REJECTED',
            strategy: 'NO_SALES_DATA',
            reasoning: 'No sales data available for pricing'
        };
    }
    
    const salesData = multiTimeframeData.bestTimeframe.data;
    const trend = multiTimeframeData.trend;
    
    // Calculate various price points from sales data - MEDIAN-FIRST approach
    const salesMedian = salesData.median || salesData.avg;
    const salesAvg = salesData.avg; // Keep for comparison only
    const salesMin = salesData.min;
    const salesMax = salesData.max;
    const salesVolume = salesData.volume;
    
    // CHEAPEST TRADEABLE ANALYSIS - Core feature integration
    const cheapestTradeable = currentMinPrice;
    const gapAnalysis = analyzeCheapestTradeableGap(buyPrice, cheapestTradeable);
    
    console.log(`[CHEAPEST TRADEABLE] Buy: €${buyPrice.toFixed(2)} vs Cheapest: €${cheapestTradeable.toFixed(2)} = ${gapAnalysis.description}`);
    
    // CRITICAL: Check against RECENT sales medians (24h/7d priority) for better outlier resistance
    const recentDataQuality = multiTimeframeData.recentDataQuality;
    const bestPeriod = multiTimeframeData.bestTimeframe.period;
    
    // Get most recent median for reality check - MEDIAN-BASED LOGIC
    const recent24hMedian = multiTimeframeData.allTimeframes.find(t => t.period === '24h')?.data.median || 
                           multiTimeframeData.allTimeframes.find(t => t.period === '24h')?.data.avg;
    const recent7dMedian = multiTimeframeData.allTimeframes.find(t => t.period === '7d')?.data.median || 
                          multiTimeframeData.allTimeframes.find(t => t.period === '7d')?.data.avg;
    
    // STEP 1: PROFITABILITY-FIRST ANALYSIS - Calculate what we NEED to make profit
    // FIX: Use ACTUAL 7d volume, fallback to reasonable estimate based on SELECTED timeframe
    const actual7dVolume = multiTimeframeData.allTimeframes.find(t => t.period === '7d')?.data.volume || 0;
    let weeklyVolume;
    
    if (actual7dVolume > 0) {
        weeklyVolume = actual7dVolume;
    } else if (bestPeriod === '24h') {
        // Conservative estimate: don't extrapolate 24h to weekly (too unreliable)
        weeklyVolume = Math.min(salesVolume * 2, salesVolume + 3); // Conservative daily to weekly estimate
    } else if (bestPeriod === '30d') {
        weeklyVolume = Math.max(salesVolume / 4, 1); // Monthly to weekly estimate
    } else if (bestPeriod === '90d') {
        weeklyVolume = Math.max(salesVolume / 12, 1); // Quarterly to weekly estimate
    } else {
        weeklyVolume = Math.max(salesVolume / 4, 1); // Default fallback
    }
    
    console.log(`[Weekly Volume Fix] ${bestPeriod} period with ${salesVolume} sales → estimated weekly: ${weeklyVolume} (actual 7d: ${actual7dVolume})`);
    
    // Simplified market analysis - focus on sales data basics
    const currentMinPrice_val = marketData.min_price;
    
    // Simple stability check based on sales data
    const isStableItem = weeklyVolume >= 3; // Just check for decent volume
    
    // Simplified margin system - consistent margins based on price range
    let minProfitMargin;
    
    if (buyPrice < 20) {
        minProfitMargin = 0.08; // 8% for smaller items
    } else if (buyPrice < 100) {
        minProfitMargin = 0.06; // 6% for medium items  
    } else {
        minProfitMargin = 0.05; // 5% for expensive items
    }
    
    // Calculate  Table price (what we MUST get to make profit)
    const minProfitablePrice = buyPrice * (1 + minProfitMargin) / (1 - SKINPORT_FEE);
    
    console.log(`[SALES-ONLY Pricing] €${buyPrice.toFixed(2)} item: Need €${minProfitablePrice.toFixed(2)} minimum (${(minProfitMargin*100).toFixed(1)}% margin) [${weeklyVolume} sales/week]`);
    
    // STEP 2: SALES-ONLY PRICING - Use ONLY actual sales data for pricing
    let recentSalesMedian = recent24hMedian || recent7dMedian || salesMedian;
    let selectedPeriod = recent24hMedian ? '24h' : recent7dMedian ? '7d' : bestPeriod;
    
    // REALITY CHECK: If minimum profit exceeds recent sales median, reject item
    if (minProfitablePrice > recentSalesMedian * 1.10) {
        console.log(`[Sales Reality Check] Minimum profit €${minProfitablePrice.toFixed(2)} exceeds recent sales median €${recentSalesMedian.toFixed(2)} by ${(((minProfitablePrice/recentSalesMedian) - 1) * 100).toFixed(1)}% - REJECTED`);
        return {
            achievablePrice: 0,
            confidence: 'REJECTED',
            strategy: 'SALES_REALITY_REJECTION',
            reasoning: `Minimum ${(minProfitMargin*100).toFixed(1)}% margin requires price above recent sales median`
        };
    }
    
    // SALES-ONLY pricing strategy with CHEAPEST TRADEABLE integration
    let basePrice;
    let strategy = 'SALES_CHEAPEST_TRADEABLE_HYBRID';
    let reasoning;
    
    // CHEAPEST TRADEABLE Strategy based on gap analysis
    if (gapAnalysis.gapCategory === 'HUGE_GAP') {
        // Huge gap: Aggressive undercut (10-15% below cheapest tradeable)
        const undercut = cheapestTradeable * 0.85; // 15% undercut
        basePrice = Math.max(undercut, minProfitablePrice);
        strategy = 'CHEAPEST_TRADEABLE_AGGRESSIVE';
        reasoning = `Huge gap pricing: 15% under cheapest tradeable (€${cheapestTradeable.toFixed(2)})`;
        
    } else if (gapAnalysis.gapCategory === 'LARGE_GAP') {
        // Large gap: Moderate undercut (5-8% below cheapest tradeable)
        const undercut = cheapestTradeable * 0.92; // 8% undercut
        basePrice = Math.max(undercut, minProfitablePrice);
        strategy = 'CHEAPEST_TRADEABLE_MODERATE';
        reasoning = `Large gap pricing: 8% under cheapest tradeable (€${cheapestTradeable.toFixed(2)})`;
        
    } else if (gapAnalysis.gapCategory === 'MEDIUM_GAP') {
        // Medium gap: Small undercut or sales-based pricing
        const undercut = cheapestTradeable * 0.95; // 5% undercut
        const salesBased = recentSalesMedian ? recentSalesMedian * 0.95 : salesMedian * 0.95;
        basePrice = Math.max(Math.min(undercut, salesBased), minProfitablePrice);
        strategy = 'CHEAPEST_TRADEABLE_SMALL';
        reasoning = `Medium gap pricing: 5% under cheapest tradeable or sales median`;
        
    } else if (gapAnalysis.gapCategory === 'SMALL_GAP') {
        // Small gap: Minimal undercut, focus on sales data
        const undercut = cheapestTradeable * 0.97; // 3% undercut
        const salesBased = recentSalesMedian ? recentSalesMedian * 0.97 : salesMedian * 0.97;
        basePrice = Math.max(Math.min(undercut, salesBased), minProfitablePrice);
        strategy = 'CHEAPEST_TRADEABLE_MINIMAL';
        reasoning = `Small gap pricing: 3% under cheapest tradeable or sales data`;
        
    } else {
        // Tiny gap: Match cheapest or slight undercut
        const undercut = cheapestTradeable * 0.99; // 1% undercut
        const salesBased = recentSalesMedian ? recentSalesMedian : salesMedian;
        basePrice = Math.max(Math.min(undercut, salesBased), minProfitablePrice);
        strategy = 'CHEAPEST_TRADEABLE_MATCH';
        reasoning = `Tiny gap pricing: match or 1% under cheapest tradeable`;
    }
    
    // REALITY CHECK: Don't exceed sales median by too much
    if (recentSalesMedian && basePrice > recentSalesMedian * 1.10) {
        basePrice = recentSalesMedian * 1.05;
        reasoning += `, capped at 105% of sales median (€${recentSalesMedian.toFixed(2)})`;
    }
    if (recentSalesMedian && salesMin && salesMax) {
        // Position ourselves in the sales range based on market conditions
        const salesRange = salesMax - salesMin;
        
        if (salesRange < recentSalesMedian * 0.1) {
            // Tight sales range - price at median
            basePrice = Math.max(recentSalesMedian, minProfitablePrice);
            reasoning = `Tight sales range - pricing at median €${recentSalesMedian.toFixed(2)}`;
        } else {
            // Normal sales range - price in bottom 30% for quick sale
            const targetPercentile = 0.30; // Bottom 30% of sales range
            const targetPrice = salesMin + (salesRange * targetPercentile);
            basePrice = Math.max(targetPrice, minProfitablePrice);
            reasoning = `Sales-only pricing at ${(targetPercentile * 100).toFixed(0)}th percentile: €${targetPrice.toFixed(2)} (min profit: €${minProfitablePrice.toFixed(2)})`;
        }
    } else {
        // Fallback to conservative median pricing
        basePrice = Math.max(recentSalesMedian * 0.95, minProfitablePrice);
        reasoning = `Conservative sales median pricing (min profit: €${minProfitablePrice.toFixed(2)})`;
    }
    
    // Apply float adjustment if available
    if (floatAnalysis && floatAnalysis.hasFloat && floatAnalysis.floatMultiplier !== 1.0) {
        const preFloatPrice = basePrice;
        basePrice *= floatAnalysis.floatMultiplier;
        reasoning += `, float-adjusted (${floatAnalysis.floatTier}: ${floatAnalysis.floatMultiplier}x)`;
        console.log(`[Float Pricing] Applied ${floatAnalysis.floatTier} multiplier: €${preFloatPrice.toFixed(2)} → €${basePrice.toFixed(2)}`);
    }
    
    // Simple trend adjustment based on sales data
    if (trend === 'RISING') {
        basePrice *= 1.02; // Small premium for rising markets
        reasoning += ', +2% for rising sales trend';
    } else if (trend === 'FALLING') {
        basePrice *= 0.98; // Small discount for falling markets  
        reasoning += ', -2% for falling sales trend';
    }
    
    // VELOCITY-BASED PRICING ADJUSTMENT - Key enhancement from enhanced algorithm
    const currentListings = marketData.quantity || 1;
    const velocity = salesVolume / (currentListings * 7);
    
    if (velocity < 0.03) {
        // Low velocity - reduce price for competitiveness (similar to enhanced algorithm)
        basePrice *= 0.97; // 3% reduction for low velocity
        reasoning += `, -3% for low velocity (${velocity.toFixed(3)})`;
        console.log(`[Velocity Adjustment] Applied -3% for low velocity: ${velocity.toFixed(3)}`);
    } else if (velocity >= 0.1) {
        // Excellent velocity - can maintain higher prices
        basePrice *= 1.01; // 1% premium for excellent velocity
        reasoning += `, +1% for excellent velocity (${velocity.toFixed(3)})`;
        console.log(`[Velocity Adjustment] Applied +1% for excellent velocity: ${velocity.toFixed(3)}`);
    }
    
    // Simple confidence based on volume
    let confidence;
    if (salesVolume >= 8) {
        confidence = 'HIGH';
    } else if (salesVolume >= 4) {
        confidence = 'MEDIUM';
    } else if (salesVolume >= 2) {
        confidence = 'LOW';
    } else {
        confidence = 'VERY_LOW';
    }
    
    // CRITICAL: Cap at recent sales maximum (don't exceed what has actually sold)
    if (basePrice > salesMax) {
        basePrice = salesMax * 0.98; // 2% below highest sale
        reasoning += ', capped at 98% of sales maximum';
    }
    
    // DOUBLE CHECK: Ensure we don't exceed recent sales median by too much
    if (basePrice > recentSalesMedian * 1.15) {
        basePrice = recentSalesMedian * 1.15;
        reasoning += ', capped at 115% of recent sales median';
    }
    
    // Final profit verification
    const finalNetPrice = basePrice * (1 - SKINPORT_FEE);
    const finalProfit = finalNetPrice - buyPrice;
    const finalMargin = (finalProfit / buyPrice) * 100;
    
    console.log(`[SALES-ONLY Final Pricing] €${basePrice.toFixed(2)} gross → €${finalNetPrice.toFixed(2)} net = €${finalProfit.toFixed(2)} profit (${finalMargin.toFixed(1)}%)`);

    return {
        achievablePrice: basePrice,
        confidence,
        strategy,
        reasoning,
        salesData: {
            median: salesMedian, // Primary pricing reference
            avg: salesAvg,       // Secondary reference for comparison
            min: salesMin,
            max: salesMax,
            volume: salesVolume,
            weeklyVolume: weeklyVolume
        },
        cheapestTradeableData: {
            price: cheapestTradeable,
            gap: gapAnalysis.gap,
            gapPercentage: gapAnalysis.gapPercentage,
            gapCategory: gapAnalysis.gapCategory,
            strategy: gapAnalysis.strategy,
            description: gapAnalysis.description
        },
        marketContext: {
            salesOnlyPricing: true,
            cheapestTradeableIntegrated: true,
            trend,
            isStableItem: isStableItem,
            minProfitRequired: minProfitablePrice,
            recentSalesMedian: recentSalesMedian,
            floatIntelligence: floatAnalysis ? {
                hasFloat: floatAnalysis.hasFloat,
                floatValue: floatAnalysis.floatValue,
                floatTier: floatAnalysis.floatTier,
                floatMultiplier: floatAnalysis.floatMultiplier,
                wearCondition: floatAnalysis.wearCondition,
                isEstimated: floatAnalysis.isEstimated || false,
                confidence: floatAnalysis.confidence || 'UNKNOWN',
                analysis: floatAnalysis.floatAnalysis
            } : null
        }
    };
}

// Function removed - confidence calculation simplified

// WEEKLY FLIP Trading Analysis - 3-7 Day Strategy for Best Accuracy & Sales
// Functions removed - weekly flip analysis simplified

/**
 * Calculate pricing algorithm accuracy by comparing recommended prices to actual sales
 */
function calculatePricingAccuracy(recommendedPrice, salesData, timeframeDays = 7) {
    if (!salesData || !recommendedPrice) {
        return {
            accuracy: 0,
            confidence: 'NO_DATA',
            analysis: 'Insufficient data for accuracy calculation'
        };
    }

    // Get the relevant timeframe data
    let relevantData;
    if (timeframeDays <= 1 && salesData.last_24_hours) {
        relevantData = salesData.last_24_hours;
    } else if (timeframeDays <= 7 && salesData.last_7_days) {
        relevantData = salesData.last_7_days;
    } else if (timeframeDays <= 30 && salesData.last_30_days) {
        relevantData = salesData.last_30_days;
    } else if (salesData.last_90_days) {
        relevantData = salesData.last_90_days;
    } else {
        return {
            accuracy: 0,
            confidence: 'NO_SALES_DATA',
            analysis: 'No sales data available for accuracy calculation'
        };
    }

    if (!relevantData || relevantData.volume === 0) {
        return {
            accuracy: 0,
            confidence: 'NO_VOLUME',
            analysis: `No sales in ${timeframeDays}d timeframe`
        };
    }

    const salesMin = relevantData.min;
    const salesMax = relevantData.max;
    const salesAvg = relevantData.avg;           // Keep for comparison
    const salesMedian = relevantData.median || salesAvg; // Primary reference for accuracy
    const salesVolume = relevantData.volume;

    // Calculate where our recommended price sits in the sales range - using median as primary reference
    let accuracyScore = 0;
    let analysis = '';

    if (recommendedPrice <= salesMax && recommendedPrice >= salesMin) {
        // Our price is within the actual sales range - good sign
        const pricePosition = (recommendedPrice - salesMin) / (salesMax - salesMin);
        
        // Additional check: How close to median (better outlier resistance)
        const medianDeviation = Math.abs(recommendedPrice - salesMedian) / salesMedian;
        
        if (pricePosition <= 0.2) {
            // Bottom 20% - very likely to sell quickly
            accuracyScore = medianDeviation <= 0.1 ? 95 : 90; // Bonus for being close to median
            analysis = `Excellent: Price in bottom 20% of sales range, ${medianDeviation <= 0.1 ? 'close to median' : 'good positioning'} (${salesVolume} sales, ${timeframeDays}d)`;
        } else if (pricePosition <= 0.4) {
            // Bottom 40% - likely to sell
            accuracyScore = medianDeviation <= 0.15 ? 85 : 80;
            analysis = `Very Good: Price in bottom 40% of sales range, ${medianDeviation <= 0.15 ? 'near median' : 'acceptable range'} (${salesVolume} sales, ${timeframeDays}d)`;
        } else if (pricePosition <= 0.6) {
            // Middle 60% - decent chance
            accuracyScore = medianDeviation <= 0.1 ? 70 : 65;
            analysis = `Good: Price in middle of sales range, ${medianDeviation <= 0.1 ? 'aligned with median' : 'moderate positioning'} (${salesVolume} sales, ${timeframeDays}d)`;
        } else if (pricePosition <= 0.8) {
            // Top 80% - might take longer
            accuracyScore = 45;
            analysis = `Fair: Price in top 40% of sales range (${salesVolume} sales, ${timeframeDays}d)`;
        } else {
            // Top 20% - likely too high
            accuracyScore = 25;
            analysis = `Poor: Price in top 20% of sales range, likely too high (${salesVolume} sales, ${timeframeDays}d)`;
        }

        // Adjust for volume (more sales = more confidence)
        if (salesVolume >= 10) {
            // High confidence due to good volume
        } else if (salesVolume >= 5) {
            accuracyScore *= 0.9; // Slight reduction for medium volume
        } else if (salesVolume >= 2) {
            accuracyScore *= 0.8; // Moderate reduction for low volume
        } else {
            accuracyScore *= 0.6; // Significant reduction for very low volume
        }

    } else if (recommendedPrice < salesMin) {
        // Our price is below the minimum sale - likely to sell but maybe too cheap
        const discountPercent = ((salesMin - recommendedPrice) / salesMin) * 100;
        if (discountPercent <= 5) {
            accuracyScore = 95;
            analysis = `Excellent: Price ${discountPercent.toFixed(1)}% below recent minimum - likely quick sale`;
        } else if (discountPercent <= 10) {
            accuracyScore = 85;
            analysis = `Very Good: Price ${discountPercent.toFixed(1)}% below recent minimum - very likely to sell`;
        } else {
            accuracyScore = 70;
            analysis = `Good but cheap: Price ${discountPercent.toFixed(1)}% below recent minimum - leaving money on table`;
        }
    } else {
        // Our price is above the maximum sale - likely too high
        const premiumPercent = ((recommendedPrice - salesMax) / salesMax) * 100;
        if (premiumPercent <= 5) {
            accuracyScore = 35;
            analysis = `Risky: Price ${premiumPercent.toFixed(1)}% above recent maximum - may not sell`;
        } else if (premiumPercent <= 10) {
            accuracyScore = 20;
            analysis = `Very Risky: Price ${premiumPercent.toFixed(1)}% above recent maximum - unlikely to sell`;
        } else {
            accuracyScore = 10;
            analysis = `Unrealistic: Price ${premiumPercent.toFixed(1)}% above recent maximum - probably won't sell`;
        }
    }

    // Determine confidence level
    let confidence;
    if (salesVolume >= 10) {
        confidence = 'HIGH';
    } else if (salesVolume >= 5) {
        confidence = 'MEDIUM';
    } else if (salesVolume >= 2) {
        confidence = 'LOW';
    } else {
        confidence = 'VERY_LOW';
    }

    return {
        accuracy: Math.round(accuracyScore),
        confidence,
        analysis,
        salesContext: {
            volume: salesVolume,
            timeframe: `${timeframeDays}d`,
            priceRange: `€${salesMin.toFixed(2)}-€${salesMax.toFixed(2)}`,
            medianPrice: `€${salesMedian.toFixed(2)}`, // Primary reference
            avgPrice: `€${salesAvg.toFixed(2)}`,       // Secondary reference
            recommendedPrice: `€${recommendedPrice.toFixed(2)}`
        }
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
        if (currentUrlLength + itemLength > maxUrlLength || currentBatch.length >= 100) { // Increased to 100 items per batch for better efficiency while avoiding URL length issues
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
 * Fetches ALL Skinport items with current market data (prices, quantities)
 */
async function fetchAllSkinportItems(currency) {
    const cacheKey = `all_items_${currency}`;
    const cachedData = cache.get(cacheKey);

    if (cachedData) {
        console.log(`[Cache] All items cache hit`);
        return cachedData;
    }

    try {
        await waitForRateLimit();
        
        const params = new URLSearchParams({
            app_id: APP_ID_CSGO,
            currency: currency
        });
        
        const url = `${SKINPORT_API_URL}/items?${params}`;
        console.log(`[API Call] Fetching ALL Skinport items for current market data`);
        
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Accept-Encoding': 'br',
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            console.error(`[API Error] Failed to fetch all Skinport items. Status: ${response.status}`);
            return {};
        }

        const data = await response.json();
        console.log(`[API Response] Received ${data.length} total Skinport items`);
        
        // Convert to lookup object by market_hash_name
        const itemsLookup = {};
        data.forEach(item => {
            if (item.market_hash_name) {
                itemsLookup[item.market_hash_name] = {
                    market_hash_name: item.market_hash_name,
                    min_price: item.min_price,
                    max_price: item.max_price,
                    mean_price: item.mean_price,
                    median_price: item.median_price,
                    quantity: item.quantity,
                    created_at: item.created_at,
                    updated_at: item.updated_at
                };
            }
        });
        
        // Cache for 5 minutes
        cache.set(cacheKey, itemsLookup);
        console.log(`[Cache] All items cached: ${Object.keys(itemsLookup).length} items`);
        
        return itemsLookup;
        
    } catch (error) {
        console.error(`[Data Collection] Error fetching all Skinport items: ${error.message}`);
        return {};
    }
}

/**
 * Fetches sales history for multiple items in a single API call
 */
async function fetchSalesHistoryBatch(marketHashNames, currency) {
    // Validate and clean market hash names
    const validNames = marketHashNames.filter(name => {
        const isValid = typeof name === 'string' && 
                       name.trim().length > 0 && 
                       name.length < 200;
        
        if (!isValid) {
            console.log(`[API] Skipping invalid market_hash_name: ${name}`);
        }
        return isValid;
    }).map(name => name.trim());

    if (validNames.length === 0) {
        console.log(`[API] No valid items in batch`);
        return {};
    }

    const batchKey = `sales_history_${validNames.sort().join(',')}_${currency}`;
    const cachedData = cache.get(batchKey);

    if (cachedData) {
        console.log(`[Cache] Sales history cache hit for ${validNames.length} items`);
        return cachedData;
    }

    try {
        await waitForRateLimit();
        
        const marketHashNamesParam = validNames.join(',');
            
        const params = new URLSearchParams({
            app_id: APP_ID_CSGO,
            currency: currency,
            market_hash_name: marketHashNamesParam
        });
        
        const url = `${SKINPORT_API_URL}/sales/history?${params}`;
        console.log(`[API Call] Fetching sales history for batch of ${validNames.length} items`);
        console.log(`[API Call] Sample names:`, validNames.slice(0, 3));
        
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
            console.error(`[API Error] Failed to fetch sales history. Status: ${response.status} ${response.statusText}`);
            console.error(`[API Error] Response body: ${responseText.substring(0, 200)}...`);
            
            // Add retry logic for 502 errors
            if (response.status === 502) {
                console.log('[API Error] Received 502 Bad Gateway, waiting 5 seconds before retry...');
                await delay(5000);
                
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
        console.log(`[API Response] Sales history received for ${data.length} items`);
        
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
        console.log(`[Cache] Sales history cached for ${validNames.length} items`);
        
        return batchData;
        
    } catch (error) {
        console.error(`[Data Collection] Error fetching sales history: ${error.message}`);
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

    try {
        const analyzedItems = [];
        
        // Extract unique market hash names (item names)
        const uniqueNames = [...new Set(items.map(item => {
            const rawName = item.marketHashName || item.name;
            return normalizeItemName(rawName);
        }).filter(name => name && name.trim()))];
        console.log(`[Backend] Extracted ${uniqueNames.length} unique item names.`);

        if (uniqueNames.length === 0) {
            return res.json({ 
                analyzedItems, 
                summary: { totalProcessed: 0, profitableFound: 0, message: 'No valid item names found' }
            });
        }

        // Fetch BOTH current market data AND sales history
        console.log(`[Backend] Fetching current market data for all items...`);
        const allMarketData = await fetchAllSkinportItems(settings.currency || 'EUR');
        
        console.log(`[Backend] Fetching sales history in batches...`);
        const batches = createOptimalBatches(uniqueNames);
        console.log(`[Backend] Split into ${batches.length} batches.`);

        // Fetch sales history for all batches
        const allSalesData = {};
        for (let i = 0; i < batches.length; i++) {
            console.log(`[Backend] Processing sales history batch ${i + 1}/${batches.length} (${batches[i].length} items)`);
            const batchData = await fetchSalesHistoryBatch(batches[i], settings.currency || 'EUR');
            Object.assign(allSalesData, batchData);
            
            // Delay between batches for rate limiting
            if (i < batches.length - 1) {
                console.log(`[Backend] Waiting 5 seconds before next batch...`);
                await delay(5000);
            }
        }

        console.log(`[Backend] Got market data for ${Object.keys(allMarketData).length} items`);
        console.log(`[Backend] Got sales history for ${Object.keys(allSalesData).length} items`);

        // Analyze each item for profitability using BOTH current market + sales history
        for (const item of items) {
            const rawItemName = item.marketHashName || item.name;
            const itemName = normalizeItemName(rawItemName);
            const itemPrice = item.price || item.skinportPrice;
            
            if (!itemName || !itemPrice) continue;

            // Skip Battle-Scarred items as requested (avoid low-demand wear condition)
            if (itemName.includes('Battle-Scarred')) {
                console.log(`[Filter] Skipping Battle-Scarred item: ${itemName}`);
                continue;
            }

            // Get both current market data AND sales history
            const marketData = allMarketData[itemName];
            const salesData = allSalesData[itemName];
            
            if (!marketData) {
                console.log(`[Backend] No current market data for: ${itemName}`);
                continue;
            }
            
            if (!salesData) {
                console.log(`[Backend] No sales history for: ${itemName}`);
                continue;
            }

            // Debug: Log the structure for first few items
            if (analyzedItems.length < 3) {
                console.log(`[Debug] Market data for "${itemName}":`, JSON.stringify(marketData, null, 2));
                console.log(`[Debug] Sales data for "${itemName}":`, JSON.stringify(salesData, null, 2).substring(0, 500) + '...');
            }

            // Extract current market data (what people are selling for NOW)
            const currentMinPrice = marketData.min_price;
            const currentMaxPrice = marketData.max_price;
            const currentMeanPrice = marketData.mean_price;
            const currentMedianPrice = marketData.median_price;
            const currentQuantity = marketData.quantity;
            
            if (!currentMinPrice || currentMinPrice <= 0) {
                console.log(`[Backend] No valid current market price for: ${itemName}`);
                continue;
            }

            // Extract sales history data using multi-timeframe analysis
            const multiTimeframeAnalysis = analyzeMultiTimeframe(salesData);
            if (!multiTimeframeAnalysis) {
                console.log(`[Backend] No valid timeframe data for: ${itemName} - insufficient sales volume`);
                continue;
            }
            
            const priceData = multiTimeframeAnalysis.bestTimeframe.data;
            const timeframePeriod = multiTimeframeAnalysis.bestTimeframe.period;
            
            // SALES VELOCITY ANALYSIS - Game changer for sellability prediction
            const salesVelocity = priceData.volume / (currentQuantity * 7); // Sales per listing per day
            const velocityCategory = salesVelocity >= 0.1 ? 'EXCELLENT' : 
                                   salesVelocity >= 0.05 ? 'GOOD' : 
                                   salesVelocity >= 0.03 ? 'MODERATE' : 
                                   salesVelocity >= 0.01 ? 'LOW' : 'VERY_LOW';
            
            console.log(`[Sales Velocity] ${itemName}: ${salesVelocity.toFixed(3)} velocity (${priceData.volume} sales / ${currentQuantity} listings / 7 days) = ${velocityCategory}`);
            
            // VELOCITY FILTER - Skip items with poor velocity (oversaturated markets)
            if (salesVelocity < 0.01) {
                console.log(`[Velocity Filter] ${itemName}: Velocity ${salesVelocity.toFixed(3)} too low - oversaturated market with ${currentQuantity} listings`);
                continue;
            }
            
            console.log(`[Multi-Timeframe] ${itemName}: Using ${timeframePeriod} data (${priceData.volume} sales, trend: ${multiTimeframeAnalysis.trend})`);
            
            // SMART ACHIEVABLE PRICE: Use actual sales data for realistic pricing
            const skinportBuyPrice = typeof itemPrice === 'number' ? itemPrice : parseFloat(itemPrice.toString().replace(',', '.'));
            
            // Float Value Intelligence Analysis with market context
            const floatAnalysis = analyzeFloatValue(itemName, skinportBuyPrice, marketData);
            console.log(`[Enhanced Float Intelligence] ${itemName}: ${floatAnalysis.floatAnalysis}`);
            
            // Apply float-adjusted expectations to minimum price
            const floatAdjustedMinPrice = currentMinPrice * floatAnalysis.floatMultiplier;
            if (floatAnalysis.hasFloat && floatAnalysis.floatMultiplier !== 1.0) {
                const adjustmentType = floatAnalysis.isEstimated ? '(estimated)' : '(explicit)';
                console.log(`[Enhanced Float Intelligence] Float-adjusted competitive price: €${floatAdjustedMinPrice.toFixed(2)} (${floatAnalysis.floatTier} float: ${floatAnalysis.floatMultiplier}x ${adjustmentType})`);
            } else if (floatAnalysis.isEstimated) {
                console.log(`[Enhanced Float Intelligence] ${floatAnalysis.floatAnalysis}`);
            }
            
            // Use float-adjusted competitive price for calculations
            const workingMinPrice = floatAdjustedMinPrice;
            
            // Calculate smart achievable price based on sales data
            const smartPricing = calculateSmartAchievablePrice(skinportBuyPrice, marketData, multiTimeframeAnalysis, workingMinPrice, floatAnalysis);
            
            // Handle market-rejected items (pricing exceeds market reality)
            if (smartPricing.achievablePrice === 0 || smartPricing.confidence === 'REJECTED') {
                console.log(`[Market Reality] ${itemName}: ${smartPricing.reasoning} - skipping`);
                continue;
            }
            
            const achievableGrossPrice = smartPricing.achievablePrice;
            const achievableNetPrice = achievableGrossPrice * (1 - SKINPORT_FEE);
            
            // Calculate profit
            const profitAmount = achievableNetPrice - skinportBuyPrice;
            const profitPercentage = (profitAmount / skinportBuyPrice) * 100;
            
            console.log(`[Smart Pricing] ${itemName}:`);
            console.log(`  Strategy: ${smartPricing.strategy}`);
            console.log(`  Reasoning: ${smartPricing.reasoning}`);
            console.log(`  Buy Price: €${skinportBuyPrice.toFixed(2)}`);
            if (floatAnalysis.hasFloat) {
                console.log(`  Float Value: ${floatAnalysis.floatValue} (${floatAnalysis.wearCondition} ${floatAnalysis.floatTier})`);
            }
            console.log(`  Achievable Price: €${achievableGrossPrice.toFixed(2)} → €${achievableNetPrice.toFixed(2)} net`);
            console.log(`  Profit: €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%)`);
            console.log(`  Confidence: ${smartPricing.confidence}`);
            
            // CHEAPEST TRADEABLE Analysis logging
            if (smartPricing.cheapestTradeableData) {
                const ctData = smartPricing.cheapestTradeableData;
                console.log(`[CHEAPEST TRADEABLE] Current cheapest: €${ctData.price.toFixed(2)}`);
                console.log(`[CHEAPEST TRADEABLE] Gap: €${ctData.gap.toFixed(2)} (${ctData.gapPercentage.toFixed(1)}%) - ${ctData.description}`);
                console.log(`[CHEAPEST TRADEABLE] Strategy: ${ctData.strategy}`);
            }
            // CRITICAL REALITY CHECK: Don't buy items above recent sales median
            const recent7dData = multiTimeframeAnalysis.allTimeframes.find(t => t.period === '7d');
            const recent7dMedian = recent7dData ? (recent7dData.data.median || recent7dData.data.avg) : null;
            
            if (recent7dMedian && skinportBuyPrice > recent7dMedian * 1.05) {
                console.log(`[Sales Reality Filter] ${itemName}: Buy price €${skinportBuyPrice.toFixed(2)} exceeds 7-day sales median €${recent7dMedian.toFixed(2)} by ${(((skinportBuyPrice/recent7dMedian) - 1) * 100).toFixed(1)}% - UNREALISTIC`);
                continue;
            }
            
            // Skip items with no profit potential (should be rare now due to market reality checks)
            if (profitAmount <= 0) {
                console.log(`[Smart Pricing] ${itemName}: No profit potential - skipping`);
                continue;
            }
            
            // Apply user's minimum criteria (only basic filters now)
            const minProfitAmount = parseFloat(settings.minProfitAmount || 0);
            const minProfitPercentage = parseFloat(settings.minProfitPercentage || 0);
            
            if (profitAmount < minProfitAmount || profitPercentage < minProfitPercentage) {
                console.log(`[Smart Pricing] ${itemName}: Below user minimum (€${profitAmount.toFixed(2)}, ${profitPercentage.toFixed(1)}%) - skipping`);
                continue;
            }
            
            // Market analysis
            const salesAvgPrice = priceData.avg;           // For compatibility 
            const salesMinPrice = priceData.min;           // For compatibility
            const salesMaxPrice = priceData.max;           // For compatibility
            const salesVolume = priceData.volume;          // For compatibility
            const salesMedian = priceData.median || priceData.avg; // Primary pricing reference
            const pricePosition = (achievableGrossPrice - salesMinPrice) / (salesMaxPrice - salesMinPrice);
            const marketSpread = currentMaxPrice - currentMinPrice;
            const marketVolatility = marketSpread > 0 ? (marketSpread / currentMeanPrice) * 100 : 0;
            
            // Calculate pricing accuracy - how likely our recommended price is to sell
            const pricingAccuracy = calculatePricingAccuracy(achievableGrossPrice, salesData, 7);
            
            // Enhanced unified confidence system: Volume + Accuracy + Velocity
            const volumeScore = priceData.volume >= 8 ? 4 : 
                               priceData.volume >= 4 ? 3 : 
                               priceData.volume >= 2 ? 2 : 1;
            
            const accuracyScore = pricingAccuracy.accuracy >= 80 ? 4 : 
                                 pricingAccuracy.accuracy >= 60 ? 3 : 
                                 pricingAccuracy.accuracy >= 40 ? 2 : 1;
            
            // NEW: Velocity score based on sales per listing per day
            const velocityScore = salesVelocity >= 0.1 ? 4 :    // Excellent velocity 
                                 salesVelocity >= 0.05 ? 3 :   // Good velocity
                                 salesVelocity >= 0.03 ? 2 :   // Moderate velocity  
                                 salesVelocity >= 0.01 ? 1 : 0; // Low velocity (filtered out above)
            
            // Enhanced combined confidence scoring (3 factors instead of 2)
            const combinedScore = (volumeScore + accuracyScore + velocityScore) / 3;
            
            let confidenceLevel, confidenceScore, colorCode, description;
            
            if (combinedScore >= 3.5) {
                confidenceLevel = 'HIGH';
                confidenceScore = 85 + Math.round((combinedScore - 3.5) * 20); // 85-95
                colorCode = 'GREEN';
                description = 'Very likely to sell quickly';
            } else if (combinedScore >= 2.5) {
                confidenceLevel = 'MEDIUM';
                confidenceScore = 60 + Math.round((combinedScore - 2.5) * 25); // 60-85
                colorCode = 'ORANGE';
                description = 'Likely to sell reasonably fast';
            } else if (combinedScore >= 1.5) {
                confidenceLevel = 'LOW';
                confidenceScore = 35 + Math.round((combinedScore - 1.5) * 25); // 35-60
                colorCode = 'ORANGE';
                description = 'May sell but could take time';
            } else {
                confidenceLevel = 'VERY_LOW';
                confidenceScore = 15 + Math.round(combinedScore * 20); // 15-35
                colorCode = 'RED';
                description = 'High risk - limited data';
            }
            
            const overallConfidence = {
                level: confidenceLevel,
                score: confidenceScore,
                factors: [
                    `Volume: ${priceData.volume} sales (${volumeScore}/4)`,
                    `Accuracy: ${pricingAccuracy.accuracy}% (${accuracyScore}/4)`,
                    `Velocity: ${salesVelocity.toFixed(3)} (${velocityScore}/4)`,
                    `Combined: ${combinedScore.toFixed(1)}/4`
                ],
                colorCode: colorCode,
                description: description,
                volumeScore: volumeScore,
                accuracyScore: accuracyScore,
                velocityScore: velocityScore,
                combinedScore: combinedScore
            };
            
            // Enhanced Liquidity-focused color override with VELOCITY integration
            let finalColorCode = colorCode;
            
            // RED: Low liquidity OR low velocity (risky/slow) - regardless of profit
            if (priceData.volume < 3 || pricingAccuracy.accuracy < 60 || salesVelocity < 0.02) {
                finalColorCode = 'RED';
                overallConfidence.description = `Low liquidity/velocity - risky/slow to sell (velocity: ${salesVelocity.toFixed(3)})`;
            }
            // ORANGE: Medium liquidity with decent profit
            else if ((priceData.volume >= 3 && priceData.volume < 8) || 
                    (pricingAccuracy.accuracy >= 60 && pricingAccuracy.accuracy < 80) ||
                    (salesVelocity >= 0.02 && salesVelocity < 0.05)) {
                finalColorCode = 'ORANGE';
                overallConfidence.description = `Medium liquidity/velocity - moderate risk (velocity: ${salesVelocity.toFixed(3)})`;
            }
            // GREEN: High liquidity, good accuracy AND good velocity
            else if (priceData.volume >= 8 && pricingAccuracy.accuracy >= 80 && salesVelocity >= 0.05) {
                finalColorCode = 'GREEN';
                overallConfidence.description = `High liquidity/velocity - likely quick sale (velocity: ${salesVelocity.toFixed(3)})`;
            }
            // Fallback to ORANGE for edge cases
            else {
                finalColorCode = 'ORANGE';
                overallConfidence.description = `Moderate conditions (velocity: ${salesVelocity.toFixed(3)})`;
            }
            
            overallConfidence.finalColorCode = finalColorCode;
            
            // Enhanced time estimate based on velocity
            let enhancedTimeEstimate;
            if (salesVelocity >= 0.1) {
                enhancedTimeEstimate = '1-2 days (Excellent velocity)';
            } else if (salesVelocity >= 0.05) {
                enhancedTimeEstimate = '2-5 days (Good velocity)';
            } else if (salesVelocity >= 0.03) {
                enhancedTimeEstimate = '1-2 weeks (Moderate velocity)';
            } else if (salesVelocity >= 0.01) {
                enhancedTimeEstimate = '2-4 weeks (Low velocity)';
            } else {
                enhancedTimeEstimate = '1+ months (Very low velocity)';
            }
            
            // Create analyzed item with smart pricing
            analyzedItems.push({
                ...item,
                name: itemName,
                skinportPrice: itemPrice,
                
                // Current market data (what's listed now)
                currentMinPrice: currentMinPrice.toFixed(2),
                currentMaxPrice: currentMaxPrice.toFixed(2),
                currentMeanPrice: currentMeanPrice.toFixed(2),
                currentMedianPrice: currentMedianPrice.toFixed(2),
                currentQuantity: currentQuantity,
                
                // Sales history data (what actually sold)
                salesAvgPrice: salesAvgPrice.toFixed(2),
                salesMinPrice: salesMinPrice.toFixed(2),
                salesMaxPrice: salesMaxPrice.toFixed(2),
                salesVolume: salesVolume,
                timeframePeriod: timeframePeriod,
                
                // Smart pricing results
                achievablePrice: achievableNetPrice.toFixed(2), // What you'll actually get after fees
                grossAchievablePrice: achievableGrossPrice.toFixed(2), // What to list at before fees
                profitAmount: profitAmount.toFixed(2),
                profitPercentage: profitPercentage.toFixed(1),
                
                // CHEAPEST TRADEABLE Analysis
                cheapestTradeableData: smartPricing.cheapestTradeableData ? {
                    price: smartPricing.cheapestTradeableData.price.toFixed(2),
                    gap: smartPricing.cheapestTradeableData.gap.toFixed(2),
                    gapPercentage: smartPricing.cheapestTradeableData.gapPercentage.toFixed(1),
                    gapCategory: smartPricing.cheapestTradeableData.gapCategory,
                    strategy: smartPricing.cheapestTradeableData.strategy,
                    description: smartPricing.cheapestTradeableData.description
                } : null,
                
                // Float Value Intelligence
                floatIntelligence: floatAnalysis.hasFloat ? {
                    floatValue: floatAnalysis.floatValue,
                    wearCondition: floatAnalysis.wearCondition,
                    floatTier: floatAnalysis.floatTier,
                    floatMultiplier: floatAnalysis.floatMultiplier,
                    floatAnalysis: floatAnalysis.floatAnalysis,
                    floatPosition: floatAnalysis.floatPosition ? (floatAnalysis.floatPosition * 100).toFixed(1) + '%' : null
                } : null,
                
                // Unified confidence system with color coding
                confidence: overallConfidence.level,
                confidenceScore: overallConfidence.score,
                confidenceFactors: overallConfidence.factors,
                confidenceColor: overallConfidence.finalColorCode, // Use final color with profit override
                confidenceDescription: overallConfidence.description,
                volumeScore: overallConfidence.volumeScore,
                accuracyScore: overallConfidence.accuracyScore,
                velocityScore: overallConfidence.velocityScore,
                combinedScore: overallConfidence.combinedScore,
                
                // Sales velocity analysis
                salesVelocity: salesVelocity.toFixed(4),
                velocityCategory: velocityCategory,
                listingCompetition: currentQuantity,
                
                timeEstimate: enhancedTimeEstimate,
                pricingStrategy: smartPricing.strategy,
                pricingReasoning: smartPricing.reasoning,
                trend: multiTimeframeAnalysis.trend,
                pricePosition: Math.round(pricePosition * 100),
                marketVolatility: marketVolatility.toFixed(1),
                
                // Pricing Accuracy Analysis - how likely our price is to sell
                pricingAccuracy: {
                    accuracy: pricingAccuracy.accuracy,
                    confidence: pricingAccuracy.confidence,
                    analysis: pricingAccuracy.analysis,
                    salesContext: pricingAccuracy.salesContext
                },
                
                // Enhanced market context with recent data priority
                recentMarketData: {
                    dataQuality: multiTimeframeAnalysis.recentDataQuality,
                    timeframe: timeframePeriod,
                    recentMedian: (salesMedian).toFixed(2),
                    vs24h: multiTimeframeAnalysis.allTimeframes.find(t => t.period === '24h') ? 
                           `€${(multiTimeframeAnalysis.allTimeframes.find(t => t.period === '24h').data.median || multiTimeframeAnalysis.allTimeframes.find(t => t.period === '24h').data.avg).toFixed(2)} (${multiTimeframeAnalysis.allTimeframes.find(t => t.period === '24h').data.volume} sales)` : 'No data',
                    vs7d: multiTimeframeAnalysis.allTimeframes.find(t => t.period === '7d') ? 
                          `€${(multiTimeframeAnalysis.allTimeframes.find(t => t.period === '7d').data.median || multiTimeframeAnalysis.allTimeframes.find(t => t.period === '7d').data.avg).toFixed(2)} (${multiTimeframeAnalysis.allTimeframes.find(t => t.period === '7d').data.volume} sales)` : 'No data',
                    velocityRating: velocityCategory
                },
                
                // Simplified market metrics
                metrics: {
                    volume: priceData.volume,
                    timeframe: multiTimeframeAnalysis.bestTimeframe.period
                },
                
                // Simple pricing strategies for comparison
                strategies: {
                    smart: {
                        price: achievableGrossPrice.toFixed(2),
                        netPrice: achievableNetPrice.toFixed(2),
                        profit: profitAmount.toFixed(2),
                        profitPercent: profitPercentage.toFixed(1)
                    },
                    competitive: {
                        price: (currentMinPrice * 0.95).toFixed(2),
                        netPrice: (currentMinPrice * 0.95 * (1 - SKINPORT_FEE)).toFixed(2),
                        profit: ((currentMinPrice * 0.95 * (1 - SKINPORT_FEE)) - skinportBuyPrice).toFixed(2),
                        profitPercent: (((currentMinPrice * 0.95 * (1 - SKINPORT_FEE)) - skinportBuyPrice) / skinportBuyPrice * 100).toFixed(1)
                    }
                },
                
                // Recommendation based on confidence and profit (REALISTIC MARKET-BASED MARGINS)
                recommendation: overallConfidence.level === 'HIGH' && profitPercentage > 3 ? 'STRONG_BUY' :
                               overallConfidence.level === 'HIGH' && profitPercentage > 1.5 ? 'BUY' :
                               overallConfidence.level === 'MEDIUM' && profitPercentage > 4 ? 'BUY' :
                               overallConfidence.level === 'MEDIUM' && profitPercentage > 2 ? 'CONSIDER' :
                               profitPercentage > 0.8 ? 'CONSIDER' : 'HOLD'
            });
            
            console.log(`[Smart Analysis] ${itemName}:`);
            console.log(`  Confidence: ${overallConfidence.level} (${overallConfidence.score}/100)`);
            console.log(`  Profit: €${profitAmount.toFixed(2)} (${profitPercentage.toFixed(1)}%)`);
            console.log(`  List Price: €${achievableGrossPrice.toFixed(2)} - Accuracy: ${pricingAccuracy.accuracy}% (${pricingAccuracy.confidence})`);
            console.log(`  Time Estimate: ${enhancedTimeEstimate}`);
            console.log(`  Strategy: ${smartPricing.strategy}`);
        }

        console.log(`[Backend] Analysis complete. Found ${analyzedItems.length} profitable items.`);
        
        // Calculate overall accuracy statistics
        const accuracyStats = {
            totalItems: analyzedItems.length,
            averageAccuracy: 0,
            accuracyDistribution: {
                excellent: 0, // 90%+
                veryGood: 0,  // 80-89%
                good: 0,      // 65-79%
                fair: 0,      // 45-64%
                poor: 0       // <45%
            },
            confidenceDistribution: {
                HIGH: 0,
                MEDIUM: 0,
                LOW: 0,
                VERY_LOW: 0,
                NO_DATA: 0
            }
        };
        
        let totalAccuracy = 0;
        analyzedItems.forEach(item => {
            const accuracy = item.pricingAccuracy.accuracy;
            const confidence = item.pricingAccuracy.confidence;
            
            totalAccuracy += accuracy;
            
            // Accuracy distribution
            if (accuracy >= 90) accuracyStats.accuracyDistribution.excellent++;
            else if (accuracy >= 80) accuracyStats.accuracyDistribution.veryGood++;
            else if (accuracy >= 65) accuracyStats.accuracyDistribution.good++;
            else if (accuracy >= 45) accuracyStats.accuracyDistribution.fair++;
            else accuracyStats.accuracyDistribution.poor++;
            
            // Confidence distribution
            accuracyStats.confidenceDistribution[confidence]++;
        });
        
        accuracyStats.averageAccuracy = analyzedItems.length > 0 ? Math.round(totalAccuracy / analyzedItems.length) : 0;
        
        console.log(`[Accuracy Analysis] Overall Algorithm Performance:`);
        console.log(`  Average Accuracy: ${accuracyStats.averageAccuracy}%`);
        console.log(`  Excellent (90%+): ${accuracyStats.accuracyDistribution.excellent} items`);
        console.log(`  Very Good (80-89%): ${accuracyStats.accuracyDistribution.veryGood} items`);
        console.log(`  Good (65-79%): ${accuracyStats.accuracyDistribution.good} items`);
        console.log(`  Fair (45-64%): ${accuracyStats.accuracyDistribution.fair} items`);
        console.log(`  Poor (<45%): ${accuracyStats.accuracyDistribution.poor} items`);
        
        // Add debug logging for item matching
        console.log(`[DEBUG] Final item names for matching:`);
        analyzedItems.slice(0, 5).forEach((item, index) => {
            console.log(`  ${index + 1}. Server: "${item.marketHashName}" | Wear: "${item.wear}" | Profit: €${item.profitAmount} | Accuracy: ${item.pricingAccuracy.accuracy}%`);
        });
        
        res.json({ 
            analyzedItems,
            summary: {
                totalProcessed: items.length,
                profitableFound: analyzedItems.length,
                uniqueItemsChecked: uniqueNames.length,
                marketDataFound: Object.keys(allMarketData).length,
                salesDataFound: Object.keys(allSalesData).length,
                strategy: 'Smart multi-timeframe pricing with sales data analysis',
                timeframe: 'Dynamic (24h, 7d, 30d, 90d)',
                algorithm: 'Enhanced smart pricing v2.0'
            },
            accuracyStats: accuracyStats
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
