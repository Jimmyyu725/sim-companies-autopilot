import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const simRoot = path.resolve(directory, "../../..");

const state = JSON.parse(fs.readFileSync(path.join(simRoot, "autopilot/.state.json"), "utf8"));
const facts = JSON.parse(fs.readFileSync(path.join(simRoot, "shared/facts/game-facts.json"), "utf8"));
const retail = JSON.parse(fs.readFileSync(
  path.join(
    simRoot,
    "autopilot/analysis/all-retail-profitability-2026-07-26/SimCompanies-Retail-Profitability-RAW-2026-07-26.json",
  ),
  "utf8",
));
const priorDecision = JSON.parse(fs.readFileSync(
  path.join(simRoot, "autopilot/analysis/coffee-vs-tools-aerospace-2026-07-26/decision-results.json"),
  "utf8",
));

const finalMillUpgradeQuote = 62_500;
const liquidityReserve = 50_000;
const interestPerHour = state.bonds.dailyInterest / 24;
const projectedCashAfterFinalMillUpgrade = state.money - finalMillUpgradeQuote;

function round(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function cumulativeCost(letter, level) {
  if (level <= 0) return 0;
  const baseCost = Number(facts.buildings[letter].levels["1"].approxCost);
  return Math.round(baseCost * (1 + level * (level - 1) / 2));
}

function cumulativeBuildHours(letter, level) {
  if (level <= 0) return 0;
  const baseText = String(facts.buildings[letter].levels["1"].buildTime);
  const baseHours = Number(baseText.match(/[\d.]+/)?.[0] ?? 0);
  return baseHours * (1 + level * (level - 1) / 2);
}

function parseProductionLevels(text) {
  return Object.fromEntries(String(text).split("; ").map((part) => {
    const [letter, value] = part.split(":");
    return [letter, Number(value)];
  }));
}

function targetLevels(row, storeLevel, forceAllOne = false) {
  const fractions = parseProductionLevels(row.productionBuildings);
  const levels = Object.fromEntries(Object.entries(fractions).map(([letter, perStoreLevel]) => [
    letter,
    forceAllOne ? 1 : Math.ceil(perStoreLevel * storeLevel - 1e-12),
  ]));
  levels[row.storeCode] = storeLevel;
  return levels;
}

function incrementalCost(target, existing) {
  return Object.entries(target).reduce((total, [letter, targetLevel]) => {
    const currentLevel = Number(existing[letter] ?? 0);
    return total + Math.max(0, cumulativeCost(letter, targetLevel) - cumulativeCost(letter, currentLevel));
  }, 0);
}

function transitionBuildHours(target, existing) {
  return Math.max(0, ...Object.entries(target).map(([letter, targetLevel]) => {
    const currentLevel = Number(existing[letter] ?? 0);
    return Math.max(0, cumulativeBuildHours(letter, targetLevel) - cumulativeBuildHours(letter, currentLevel));
  }));
}

function totalCost(levels) {
  return Object.entries(levels).reduce((sum, [letter, level]) => sum + cumulativeCost(letter, level), 0);
}

function operatingSavings(profitPerHour, utilization) {
  return Math.max(0, profitPerHour * utilization - interestPerHour);
}

function hoursToFund(requiredCash, availableCash, savingsPerHour) {
  return Math.max(0, requiredCash - availableCash) / savingsPerHour;
}

const toolsRow = retail.executableRows.find((row) => row.kind === 110 && row.quality === 0);
const satelliteRow = retail.modelRows.find((row) => row.kind === 99 && row.quality === 0);
if (!toolsRow || !satelliteRow) throw new Error("Required Tools or Satellite retail row is missing");

const projectedCoffeeLevels = {
  E: 1,
  W: 1,
  P: 3,
  G: 2,
};
const projectedMillSalvage = 3 * cumulativeCost("i", 3);
const projectedCoffeeSpecificSalvage = projectedMillSalvage
  + cumulativeCost("P", 3)
  + cumulativeCost("G", 2);

function confirmedCommercialActivity() {
  const lines = fs.readFileSync(path.join(simRoot, "autopilot/brain.log"), "utf8").split(/\n/);
  let retailRevenueLowerBound = 0;
  let retailOrders = 0;
  let exchangeRevenueLowerBound = 0;
  let exchangeOrders = 0;
  let pendingExchange = null;

  for (const line of lines) {
    if (line.includes("TOOL exchange_sell ")) {
      const raw = line.slice(line.indexOf("TOOL exchange_sell ") + "TOOL exchange_sell ".length);
      try {
        const request = JSON.parse(raw);
        pendingExchange = request.confirm === true ? request : null;
      } catch {
        pendingExchange = null;
      }
      continue;
    }
    if (pendingExchange && line.includes("  -> ")) {
      if (line.includes('"ok":true') && line.includes('"submitted"')) {
        exchangeRevenueLowerBound += Number(pendingExchange.qty) * Number(pendingExchange.price);
        exchangeOrders += 1;
      }
      pendingExchange = null;
    }
    if (line.includes('  -> {"ok":true') && line.includes('"entered":{"qty":')) {
      const match = line.match(/"entered":\{"qty":([\d.]+),"price":([\d.]+)/);
      if (match) {
        retailRevenueLowerBound += Number(match[1]) * Number(match[2]);
        retailOrders += 1;
      }
    }
  }
  return {
    retailRevenueLowerBound: round(retailRevenueLowerBound),
    retailOrders,
    exchangeRevenueLowerBound: round(exchangeRevenueLowerBound),
    exchangeOrders,
  };
}

const commercialActivity = confirmedCommercialActivity();
const projectedWorkerEstimate = round((
  facts.buildings.W.wage * 1
  + facts.buildings.E.wage * 1
  + facts.buildings.P.wage * 3
  + facts.buildings.i.wage * 9
  + facts.buildings.G.wage * 2
) / 345 * 1000, 0);

const achievementOpportunities = {
  claimStatus: "UNKNOWN_AUTHENTICATED_PAGE_UNAVAILABLE",
  automaticCollectionSupportedByAutopilot: false,
  verifiedEligibleRewardCeilingExcludingDaily: 188_900,
  tiers: [
    {
      name: "Builder",
      metric: "standard buildings",
      observed: state.usedSlots,
      highestVerifiedThreshold: 5,
      eligibleRewardsIfUnclaimed: 12_000,
      confidence: "verified eligibility",
    },
    {
      name: "Employer",
      metric: "estimated workers",
      observed: projectedWorkerEstimate,
      highestVerifiedThreshold: 2_000,
      eligibleRewardsIfUnclaimed: 40_000,
      confidence: "derived eligibility",
    },
    {
      name: "Retailer",
      metric: "confirmed retail revenue lower bound",
      observed: commercialActivity.retailRevenueLowerBound,
      highestVerifiedThreshold: 100_000,
      eligibleRewardsIfUnclaimed: 55_800,
      confidence: "verified lower bound",
    },
    {
      name: "Supplier",
      metric: "confirmed exchange revenue lower bound",
      observed: commercialActivity.exchangeRevenueLowerBound,
      highestVerifiedThreshold: 10_000,
      eligibleRewardsIfUnclaimed: 6_100,
      confidence: "verified lower bound",
    },
    {
      name: "Start-up",
      metric: "bonds raised",
      observed: state.bonds.principalOutstanding,
      highestVerifiedThreshold: 250_000,
      eligibleRewardsIfUnclaimed: 75_000,
      confidence: "verified eligibility",
    },
  ],
  freeDailyChecks: [
    "Logged in today",
    "Produced today",
    "Sold today",
  ],
  nextStrategicAchievement: {
    name: "Architect",
    requirement: "Have a level 5 building",
    reward: 100_000,
    currentMaximumStandardBuildingLevelAfterCommittedUpgrade: 3,
    recommendedRouteIfUnclaimed: "Build one additional Farm in a free slot and take it to L5, preserving the current L3 Farm during construction.",
    approximateNewFarmToL5Cost: cumulativeCost("P", 5),
    approximateBuildHours: cumulativeBuildHours("P", 5),
    nominalRewardMinusApproximateCost: 100_000 - cumulativeCost("P", 5),
  },
  avoidForNow: [
    "Prospector build-and-scrap loops until a live scrap-return quote proves the loss is below the reward.",
    "Scientist and Know-it-all research solely for achievement rewards at the current company scale.",
    "Any contest donation; official guidance warns serious entries cost tens of millions.",
  ],
};

const coffeeProfitPerHour = priorDecision.currentCoffee.constrainedRetail.profitPerHour;
const toolsProfitPerStoreLevel = toolsRow.operatingNetPerHour;
const satelliteProfitPerStoreLevel = satelliteRow.operatingNetPerHour;
const toolsLevelOne = targetLevels(toolsRow, 1);
const toolsMinimumAllLevelOne = targetLevels(toolsRow, 1, true);
const satelliteFullyFed = targetLevels(satelliteRow, 1);
const satelliteMinimumAllLevelOne = targetLevels(satelliteRow, 1, true);

function initialPivot(target, salvage, profitPerHour, outputPerHour) {
  const grossIncremental = incrementalCost(target, projectedCoffeeLevels);
  const optimisticCapital = Math.max(0, grossIncremental - salvage);
  const conservativeCapital = grossIncremental;
  const buildHours = transitionBuildHours(target, projectedCoffeeLevels);
  const timelines = {};
  for (const utilization of [1, 0.8, 0.7, 0.6]) {
    const savings = operatingSavings(coffeeProfitPerHour, utilization);
    timelines[String(utilization)] = {
      coffeeSavingsPerHour: round(savings),
      optimisticFundingDays: round(hoursToFund(
        optimisticCapital + liquidityReserve,
        projectedCashAfterFinalMillUpgrade,
        savings,
      ) / 24, 1),
      conservativeFundingDays: round(hoursToFund(
        conservativeCapital + liquidityReserve,
        projectedCashAfterFinalMillUpgrade,
        savings,
      ) / 24, 1),
    };
  }
  return {
    target,
    outputPerHour,
    profitPerHour,
    grossIncremental,
    salvageOffset: salvage,
    optimisticCapital,
    conservativeCapital,
    buildHours,
    timelines,
  };
}

const toolsMinimumPivot = initialPivot(
  toolsMinimumAllLevelOne,
  projectedMillSalvage,
  priorDecision.tools.levelOneEconomics.profitPerHour,
  priorDecision.tools.levelOneCapacityPerHour,
);
const toolsPracticalPivot = initialPivot(
  toolsLevelOne,
  projectedMillSalvage,
  toolsProfitPerStoreLevel,
  toolsRow.unitsPerHour,
);
const satelliteMinimumPivot = initialPivot(
  satelliteMinimumAllLevelOne,
  projectedCoffeeSpecificSalvage,
  priorDecision.satellite.levelOneEconomics.profitPerHour,
  priorDecision.satellite.levelOneCapacityPerHour,
);
const satelliteFullDirectPivot = initialPivot(
  satelliteFullyFed,
  projectedCoffeeSpecificSalvage,
  satelliteProfitPerStoreLevel,
  satelliteRow.unitsPerHour,
);

function toolsToSatelliteScenario(storeLevel, utilization, useSalvage) {
  const toolsTarget = targetLevels(toolsRow, storeLevel);
  const existingAtTools = {
    ...projectedCoffeeLevels,
    ...toolsTarget,
    P: Math.max(projectedCoffeeLevels.P, toolsTarget.P ?? 0),
  };

  const toolsGrossCapital = incrementalCost(toolsTarget, projectedCoffeeLevels);
  const toolsCapital = Math.max(0, toolsGrossCapital - (useSalvage ? projectedMillSalvage : 0));
  const coffeeSavings = operatingSavings(coffeeProfitPerHour, utilization);
  const daysFundingTools = hoursToFund(
    toolsCapital + liquidityReserve,
    projectedCashAfterFinalMillUpgrade,
    coffeeSavings,
  ) / 24;
  const daysBuildingTools = transitionBuildHours(toolsTarget, projectedCoffeeLevels) / 24;

  const satelliteGrossCapital = incrementalCost(satelliteFullyFed, existingAtTools);
  const nonSatelliteLetters = Object.keys(existingAtTools).filter((letter) => !(letter in satelliteFullyFed) && letter !== "i");
  const nonSatelliteSalvage = nonSatelliteLetters.reduce(
    (sum, letter) => sum + cumulativeCost(letter, existingAtTools[letter]),
    0,
  );
  const satelliteCapital = Math.max(
    0,
    satelliteGrossCapital - (useSalvage ? nonSatelliteSalvage : 0),
  );
  const toolsSavings = operatingSavings(toolsProfitPerStoreLevel * storeLevel, utilization);
  const daysFundingSatellite = satelliteCapital / toolsSavings / 24;
  const daysBuildingSatellite = transitionBuildHours(satelliteFullyFed, existingAtTools) / 24;

  return {
    storeLevel,
    utilization,
    salvageMode: useSalvage ? "optimistic-material-match" : "no-salvage-credit",
    toolsTarget,
    toolsOperatingProfitPerHour: round(toolsProfitPerStoreLevel * storeLevel),
    toolsSavingsPerHour: round(toolsSavings),
    toolsCapital,
    daysFundingTools: round(daysFundingTools, 1),
    daysBuildingTools: round(daysBuildingTools, 1),
    satelliteCapital,
    daysFundingSatellite: round(daysFundingSatellite, 1),
    daysBuildingSatellite: round(daysBuildingSatellite, 1),
    totalDays: round(
      daysFundingTools + daysBuildingTools + daysFundingSatellite + daysBuildingSatellite,
      1,
    ),
  };
}

const stagedScenarios = [];
for (const utilization of [1, 0.8, 0.7, 0.6]) {
  for (const useSalvage of [true, false]) {
    for (let storeLevel = 1; storeLevel <= 8; storeLevel += 1) {
      stagedScenarios.push(toolsToSatelliteScenario(storeLevel, utilization, useSalvage));
    }
  }
}

const bestStaged = {};
for (const utilization of [1, 0.8, 0.7, 0.6]) {
  bestStaged[String(utilization)] = {};
  for (const salvageMode of ["optimistic-material-match", "no-salvage-credit"]) {
    bestStaged[String(utilization)][salvageMode] = stagedScenarios
      .filter((row) => row.utilization === utilization && row.salvageMode === salvageMode)
      .sort((a, b) => a.totalDays - b.totalDays)
      .slice(0, 3);
  }
}

function sequentialToolsToSatelliteScenario(maxStoreLevel, utilization, useSalvage) {
  const coffeeSavings = operatingSavings(coffeeProfitPerHour, utilization);
  const stages = [];
  let totalDays = 0;
  let previousLevels = { ...projectedCoffeeLevels };

  for (let storeLevel = 1; storeLevel <= maxStoreLevel; storeLevel += 1) {
    const nextLevels = targetLevels(toolsRow, storeLevel);
    const targetWithPreservedAssets = {
      ...previousLevels,
      ...nextLevels,
      P: Math.max(previousLevels.P ?? 0, nextLevels.P ?? 0),
    };
    const grossCapital = incrementalCost(nextLevels, previousLevels);
    const salvageOffset = storeLevel === 1 && useSalvage ? projectedMillSalvage : 0;
    const capital = Math.max(0, grossCapital - salvageOffset);
    const fundingSavings = storeLevel === 1
      ? coffeeSavings
      : operatingSavings(toolsProfitPerStoreLevel * (storeLevel - 1), utilization);
    const availableCash = storeLevel === 1 ? projectedCashAfterFinalMillUpgrade : liquidityReserve;
    const fundingDays = hoursToFund(capital + liquidityReserve, availableCash, fundingSavings) / 24;
    const buildingDays = transitionBuildHours(nextLevels, previousLevels) / 24;
    totalDays += fundingDays + buildingDays;
    stages.push({
      stage: `Tools L${storeLevel}`,
      capital,
      fundingSavingsPerHour: round(fundingSavings),
      fundingDays: round(fundingDays, 1),
      buildingDays: round(buildingDays, 1),
      cumulativeDays: round(totalDays, 1),
    });
    previousLevels = targetWithPreservedAssets;
  }

  const satelliteGrossCapital = incrementalCost(satelliteFullyFed, previousLevels);
  const nonSatelliteLetters = Object.keys(previousLevels)
    .filter((letter) => !(letter in satelliteFullyFed) && letter !== "i");
  const nonSatelliteSalvage = nonSatelliteLetters.reduce(
    (sum, letter) => sum + cumulativeCost(letter, previousLevels[letter]),
    0,
  );
  const satelliteCapital = Math.max(
    0,
    satelliteGrossCapital - (useSalvage ? nonSatelliteSalvage : 0),
  );
  const satelliteFundingSavings = operatingSavings(
    toolsProfitPerStoreLevel * maxStoreLevel,
    utilization,
  );
  const satelliteFundingDays = satelliteCapital / satelliteFundingSavings / 24;
  const satelliteBuildingDays = transitionBuildHours(satelliteFullyFed, previousLevels) / 24;
  totalDays += satelliteFundingDays + satelliteBuildingDays;
  stages.push({
    stage: "Satellite full feed",
    capital: satelliteCapital,
    fundingSavingsPerHour: round(satelliteFundingSavings),
    fundingDays: round(satelliteFundingDays, 1),
    buildingDays: round(satelliteBuildingDays, 1),
    cumulativeDays: round(totalDays, 1),
  });

  return {
    maxStoreLevel,
    utilization,
    salvageMode: useSalvage ? "optimistic-material-match" : "no-salvage-credit",
    totalDays: round(totalDays, 1),
    stages,
  };
}

const sequentialScenarios = [];
for (const utilization of [1, 0.8, 0.7, 0.6]) {
  for (const useSalvage of [true, false]) {
    for (let maxStoreLevel = 1; maxStoreLevel <= 8; maxStoreLevel += 1) {
      sequentialScenarios.push(sequentialToolsToSatelliteScenario(
        maxStoreLevel,
        utilization,
        useSalvage,
      ));
    }
  }
}

const bestSequential = {};
for (const utilization of [1, 0.8, 0.7, 0.6]) {
  bestSequential[String(utilization)] = {};
  for (const salvageMode of ["optimistic-material-match", "no-salvage-credit"]) {
    bestSequential[String(utilization)][salvageMode] = sequentialScenarios
      .filter((row) => row.utilization === utilization && row.salvageMode === salvageMode)
      .sort((a, b) => a.totalDays - b.totalDays)
      .slice(0, 3);
  }
}

const result = {
  generatedAtUtc: new Date().toISOString(),
  sources: {
    stateAsOfUtc: state.t,
    retailModelGeneratedAtUtc: retail.generatedAt,
    priorDecisionGeneratedAtUtc: priorDecision.generatedAtUtc,
  },
  company: {
    cashNow: state.money,
    projectedCashAfterFinalMillUpgrade,
    finalMillUpgradeQuoteAssumption: finalMillUpgradeQuote,
    debtPrincipal: state.bonds.principalOutstanding,
    dailyInterest: state.bonds.dailyInterest,
    interestPerHour: round(interestPerHour, 4),
    liquidityReserve,
    slots: state.slotCapacity,
  },
  economics: {
    coffeeProfitPerHour,
    toolsProfitPerStoreLevel,
    satelliteProfitPerStoreLevel,
    satelliteProfitStatus: satelliteRow.executionStatus,
  },
  projectedSalvage: {
    threeLevelThreeMills: projectedMillSalvage,
    allCoffeeSpecificBuildings: projectedCoffeeSpecificSalvage,
    caveat: "Approximate material value only; it is not cash and requires matching construction inputs.",
  },
  commercialActivity,
  achievementOpportunities,
  pivots: {
    toolsMinimumAllLevelOne: toolsMinimumPivot,
    toolsPracticalFullyFedLevelOneStore: toolsPracticalPivot,
    satelliteMinimumAllLevelOne: satelliteMinimumPivot,
    satelliteFullyFedLevelOneSalesOfficeDirect: satelliteFullDirectPivot,
  },
  satelliteFullyFed: {
    targetLevels: satelliteFullyFed,
    capexFromScratch: totalCost(satelliteFullyFed),
    requiredProductionLevels: satelliteRow.requiredProductionLevels,
    totalOperatingLevels: satelliteRow.totalOperatingLevels,
    modelCeilingProfitPerHour: satelliteProfitPerStoreLevel,
    executionStatus: satelliteRow.executionStatus,
  },
  stagedScenarios,
  bestStaged,
  sequentialScenarios,
  bestSequential,
  caveats: [
    "Retail demand, market prices, wages, administration overhead, and modifiers are held constant.",
    "Satellite is a model ceiling: live Sales Office client frequency and order size are not verified.",
    "Construction paths assume separate buildings can upgrade in parallel and add the longest building path as downtime.",
    "No additional bonds are assumed; the current $275,000 debt remains outstanding.",
    "Salvage-credit scenarios assume returned materials can replace the exact materials needed by the next build.",
  ],
};

fs.writeFileSync(path.join(directory, "timeline-results.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  generatedAtUtc: result.generatedAtUtc,
  company: result.company,
  tools: result.pivots.toolsPracticalFullyFedLevelOneStore,
  satelliteDirect: result.pivots.satelliteFullyFedLevelOneSalesOfficeDirect,
  bestStaged: result.bestStaged,
  bestSequential: result.bestSequential,
}, null, 2));
