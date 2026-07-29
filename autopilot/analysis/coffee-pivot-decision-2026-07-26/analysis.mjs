import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const simRoot = path.resolve(scriptDirectory, "../../..");

const paths = {
  facts: path.join(simRoot, "shared/facts/game-facts.json"),
  bundle: path.join(simRoot, "bundle-main.js"),
  marketSnapshot: path.join(
    simRoot,
    "autopilot/analysis/self-produced-retail-2026-07-26/market-snapshot.json",
  ),
  state: path.join(simRoot, "autopilot/.state.json"),
  brainLog: path.join(simRoot, "autopilot/brain.log"),
  output: path.join(scriptDirectory, "decision-results.json"),
};

const facts = JSON.parse(fs.readFileSync(paths.facts, "utf8"));
const marketSnapshot = JSON.parse(fs.readFileSync(paths.marketSnapshot, "utf8"));
const state = JSON.parse(fs.readFileSync(paths.state, "utf8"));
const bundle = fs.readFileSync(paths.bundle, "utf8");
const brainLog = fs.readFileSync(paths.brainLog, "utf8");

const averageSalary = 345;
const salaryMid = 700;
const miningAbundance = 0.88;
const miningKinds = new Set([10, 14, 15, 42, 44, 68, 74, 104, 105]);
const salesOfficeCurveFactor = 2.28;
const permanentProductionModifier =
  marketSnapshot.company.permanentProductionModifierPercent;
const permanentSalesModifier = marketSnapshot.company.permanentSalesModifierPercent;
const administrationOverhead = marketSnapshot.company.administrationOverhead;

const retailModelsStartMarker = "'),1:JSON.parse('";
const retailModelsStart =
  bundle.indexOf(retailModelsStartMarker) + retailModelsStartMarker.length;
const retailModelsEnd = bundle.indexOf("')},kKe", retailModelsStart);
const retailModelsSource = bundle.slice(retailModelsStart, retailModelsEnd);

const retailRows = new Map(
  marketSnapshot.retail
    .filter((row) => row.quality === null)
    .map((row) => [Number(row.kind), row]),
);

function salaryModifier(buildingLetter) {
  return Math.round((facts.buildings[buildingLetter].wage / averageSalary) * 10) / 10;
}

function loadRetailModel(kind) {
  const match = retailModelsSource.match(
    new RegExp(`"${kind}":(\\{[^{}]+\\})`),
  );
  if (!match) {
    throw new Error(`Retail model not found for kind ${kind}`);
  }
  return JSON.parse(match[1]);
}

function temporaryModifiersWithout(...excludedKinds) {
  const excluded = new Set(excludedKinds);
  return new Map(
    marketSnapshot.productionModifiers
      .filter((modifier) => !excluded.has(Number(modifier.kind)))
      .map((modifier) => [Number(modifier.kind), Number(modifier.speedModifier)]),
  );
}

function createProductionModel(temporaryModifiers) {
  const costCache = new Map();

  function productionRate(kind) {
    const resource = facts.resources[String(kind)];
    const modifier = salaryModifier(resource.producedAt);
    const abundance = miningKinds.has(Number(kind)) ? miningAbundance : 1;
    const temporaryModifier = temporaryModifiers.get(Number(kind)) ?? 0;
    return (
      resource.ratePerHourRaw *
      (averageSalary / salaryMid) ** modifier *
      abundance *
      (1 + temporaryModifier / 100) /
      (1 - permanentProductionModifier / 100)
    );
  }

  function ownCost(kind) {
    const numericKind = Number(kind);
    if (costCache.has(numericKind)) {
      return costCache.get(numericKind);
    }
    const resource = facts.resources[String(numericKind)];
    const modifier = salaryModifier(resource.producedAt);
    const directLabor =
      (averageSalary * modifier * administrationOverhead) /
      productionRate(numericKind);
    const inputCost = Object.entries(resource.recipe).reduce(
      (sum, [inputKind, quantity]) =>
        sum + Number(quantity) * ownCost(Number(inputKind)),
      0,
    );
    const total = directLabor + inputCost;
    costCache.set(numericKind, total);
    return total;
  }

  function productionLevels(kind, multiplier = 1, totals = new Map()) {
    const resource = facts.resources[String(kind)];
    totals.set(
      resource.producedAt,
      (totals.get(resource.producedAt) ?? 0) +
        multiplier / productionRate(Number(kind)),
    );
    for (const [inputKind, quantity] of Object.entries(resource.recipe)) {
      productionLevels(
        Number(inputKind),
        multiplier * Number(quantity),
        totals,
      );
    }
    return totals;
  }

  return { ownCost, productionLevels, productionRate };
}

function retailParameters(store, kind) {
  const model = loadRetailModel(kind);
  const saturation = Number(retailRows.get(Number(kind)).saturation);
  const demandFactor = Math.min(Math.max(2 - saturation, 0), 2);
  const priceFactor = Math.max(0.9, demandFactor / 2 + 0.5);
  const storeCurveFactor = store === "B" ? salesOfficeCurveFactor : 1;
  const variableCost =
    370 *
    (model.buildingLevelsNeededPerUnitPerHour *
      model.modeledUnitsSoldAnHour +
      1) *
    storeCurveFactor *
    (demandFactor / 2);
  const modeledStoreWages = model.modeledStoreWages ?? 0;
  const modeledUnits = model.modeledUnitsSoldAnHour * priceFactor;
  const modeledPrice =
    model.modeledProductionCostPerUnit +
    (variableCost + modeledStoreWages) / modeledUnits;
  return {
    model,
    modeledPrice,
    modeledStoreWages,
    variableCost,
  };
}

function retailUnitsPerHour(store, kind, price, quantity = 100) {
  const { model, modeledPrice, modeledStoreWages, variableCost } =
    retailParameters(store, kind);
  const curve =
    variableCost -
    (price - modeledPrice) ** 2 *
      ((modeledStoreWages + variableCost) /
        (modeledPrice - model.modeledProductionCostPerUnit) ** 2);
  const seconds =
    ((quantity * (price - model.modeledProductionCostPerUnit) * 3600 -
      modeledStoreWages) /
      (curve + modeledStoreWages)) *
    (1 - permanentSalesModifier / 100);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return (quantity * 3600) / seconds;
}

function optimizeRetail(store, kind, productionModel) {
  const { model, modeledPrice } = retailParameters(store, kind);
  const ownCost = productionModel.ownCost(kind);
  const lowerPrice = Math.max(
    model.modeledProductionCostPerUnit + 0.01,
    ownCost,
  );
  const upperPrice =
    2 * modeledPrice - model.modeledProductionCostPerUnit - 0.01;
  const storeWage =
    averageSalary * salaryModifier(store) * administrationOverhead;

  function netProfit(price) {
    const units = retailUnitsPerHour(store, kind, price);
    return (price - ownCost) * units - storeWage;
  }

  let left = lowerPrice;
  let right = upperPrice;
  for (let iteration = 0; iteration < 160; iteration += 1) {
    const third = (right - left) / 3;
    const first = left + third;
    const second = right - third;
    if (netProfit(first) < netProfit(second)) {
      left = first;
    } else {
      right = second;
    }
  }

  const centerCents = Math.round(((left + right) / 2) * 100);
  const candidates = new Set([
    Math.ceil(lowerPrice * 100),
    Math.floor(upperPrice * 100),
  ]);
  for (let cents = centerCents - 300; cents <= centerCents + 300; cents += 1) {
    if (cents >= Math.ceil(lowerPrice * 100) && cents <= Math.floor(upperPrice * 100)) {
      candidates.add(cents);
    }
  }

  let best = null;
  for (const cents of candidates) {
    const price = cents / 100;
    const units = retailUnitsPerHour(store, kind, price);
    const profit = (price - ownCost) * units - storeWage;
    if (!best || profit > best.netProfitPerHourPerStoreLevel) {
      best = {
        price,
        unitsPerHourPerStoreLevel: units,
        netProfitPerHourPerStoreLevel: profit,
      };
    }
  }

  const productionLevels = [...productionModel.productionLevels(kind).values()].reduce(
    (sum, value) => sum + value,
    0,
  ) * best.unitsPerHourPerStoreLevel;
  const minimumSlots = productionModel.productionLevels(kind).size + 1;

  return {
    kind,
    ownCost,
    ...best,
    productionLevels,
    minimumSlots,
    profitPerTotalBuildingLevel:
      best.netProfitPerHourPerStoreLevel / (1 + productionLevels),
  };
}

function matchRetailSpeed(store, kind, targetUnitsPerHourPerStoreLevel) {
  const { model, modeledPrice } = retailParameters(store, kind);
  let left = modeledPrice;
  let right =
    2 * modeledPrice - model.modeledProductionCostPerUnit - 0.01;
  for (let iteration = 0; iteration < 160; iteration += 1) {
    const middle = (left + right) / 2;
    if (retailUnitsPerHour(store, kind, middle) > targetUnitsPerHourPerStoreLevel) {
      left = middle;
    } else {
      right = middle;
    }
  }
  return (left + right) / 2;
}

function latestCoffeeRetailOrder() {
  const pattern =
    /"entered":\{"qty":(\d+),"price":([0-9.]+)\},"before":"COFFEE POWDER Stock: (\d+) Profit per unit: \$([0-9.]+) Finishes: .*? in (\d+)m, (\d+)s Profit per hour: \$([0-9,]+)/g;
  let latest = null;
  for (const match of brainLog.matchAll(pattern)) {
    if (Number(match[1]) !== Number(match[3])) {
      continue;
    }
    latest = {
      quantity: Number(match[1]),
      price: Number(match[2]),
      profitPerUnit: Number(match[4]),
      durationSeconds: Number(match[5]) * 60 + Number(match[6]),
      displayedProfitPerHour: Number(match[7].replaceAll(",", "")),
    };
  }
  if (!latest) {
    throw new Error("A live Coffee Powder retail order was not found in brain.log");
  }
  latest.unitsPerHour = (latest.quantity * 3600) / latest.durationSeconds;
  latest.recomputedProfitPerHour = latest.unitsPerHour * latest.profitPerUnit;
  return latest;
}

function latestCoffeeUnitCost() {
  const matches = [...brainLog.matchAll(/COFFEE POWDER[\s\S]{0,180}?Unit cost: \$([0-9.]+)/g)];
  if (matches.length === 0) {
    throw new Error("A live Coffee Powder unit cost was not found in brain.log");
  }
  return Number(matches.at(-1)[1]);
}

function latestMillWagesPerHour() {
  const matches = [
    ...brainLog.matchAll(
      /"wagesPerHour":(\d+),"busy":false,"products":\[\{"name":"COFFEE POWDER"/g,
    ),
  ];
  return matches.length > 0 ? Number(matches.at(-1)[1]) : null;
}

function addHours(isoTimestamp, hours) {
  return new Date(new Date(isoTimestamp).getTime() + hours * 60 * 60 * 1000).toISOString();
}

const currentModifiers = temporaryModifiersWithout();
const afterPowderEventModifiers = temporaryModifiersWithout(119);
const afterCoffeeEventsModifiers = temporaryModifiersWithout(118, 119);
const currentProduction = createProductionModel(currentModifiers);
const afterPowderEventProduction = createProductionModel(afterPowderEventModifiers);
const afterCoffeeEventsProduction = createProductionModel(afterCoffeeEventsModifiers);

const options = [
  {
    option: "Continue Coffee — current event",
    store: "Grocery Store",
    product: "Coffee Powder",
    evidence: "Live-verified production and retail formula",
    transition: "No rebuild",
    ...optimizeRetail("G", 119, currentProduction),
  },
  {
    option: "Continue Coffee — after -23% event",
    store: "Grocery Store",
    product: "Coffee Powder",
    evidence: "Validated formula projection",
    transition: "No rebuild",
    ...optimizeRetail("G", 119, afterPowderEventProduction),
  },
  {
    option: "Pivot to Diesel",
    store: "Gas Station",
    product: "Diesel",
    evidence: "Formula-only; chain not owned",
    transition: "Full rebuild",
    ...optimizeRetail("A", 12, currentProduction),
  },
  {
    option: "Pivot to Chocolate",
    store: "Grocery Store",
    product: "Chocolate",
    evidence: "Formula-only; chain not owned",
    transition: "Full rebuild",
    ...optimizeRetail("G", 140, currentProduction),
  },
  {
    option: "Pivot to Necklace",
    store: "Fashion Store",
    product: "Necklace",
    evidence: "Formula-only; chain not owned",
    transition: "Full rebuild",
    ...optimizeRetail("H", 71, currentProduction),
  },
];

const liveOrder = latestCoffeeRetailOrder();
const liveCoffeeUnitCost = latestCoffeeUnitCost();
const liveMillWagesPerHour = latestMillWagesPerHour();
const millLevels = state.buildings
  .filter((building) => building.kindLetter === "i")
  .reduce((sum, building) => sum + Number(building.size), 0);
const activeMillLevels = state.buildings
  .filter(
    (building) =>
      building.kindLetter === "i" && building.busy?.expanding !== true,
  )
  .reduce((sum, building) => sum + Number(building.size), 0);
const groceryLevel = state.buildings
  .filter((building) => building.kindLetter === "G")
  .reduce((sum, building) => sum + Number(building.size), 0);
const standardBuildings = state.buildings.filter(
  (building) => building.kindLetter !== "z",
).length;

function currentCompanyCoffeeScenario(label, productionModel, sourceCost) {
  const powderThroughput =
    millLevels * productionModel.productionRate(119);
  const targetPerStoreLevel = powderThroughput / groceryLevel;
  const matchedPrice = matchRetailSpeed("G", 119, targetPerStoreLevel);
  const groceryWage =
    averageSalary *
    salaryModifier("G") *
    administrationOverhead *
    groceryLevel;
  return {
    label,
    millLevels,
    groceryLevel,
    powderThroughputPerHour: powderThroughput,
    matchedRetailPrice: matchedPrice,
    sourceCostPerUnit: sourceCost,
    estimatedCompanyProfitPerHour:
      (matchedPrice - sourceCost) * powderThroughput - groceryWage,
  };
}

const companyScenarios = [
  currentCompanyCoffeeScenario(
    "After current Mill upgrade, during -23% event",
    currentProduction,
    liveCoffeeUnitCost,
  ),
  currentCompanyCoffeeScenario(
    "After -23% event, recursive self-cost",
    afterPowderEventProduction,
    afterPowderEventProduction.ownCost(119),
  ),
];

const currentCoffeeOption = options.find(
  (option) => option.option === "Continue Coffee — current event",
);
const postEventCoffeeOption = options.find(
  (option) => option.option === "Continue Coffee — after -23% event",
);
const baselineCoffeeOption = {
  option: "Continue Coffee — after current Powder and Beans events",
  store: "Grocery Store",
  product: "Coffee Powder",
  evidence: "Validated formula projection",
  transition: "No rebuild",
  ...optimizeRetail("G", 119, afterCoffeeEventsProduction),
};
const dieselOption = options.find((option) => option.option === "Pivot to Diesel");
const dieselPaperAdvantage =
  dieselOption.netProfitPerHourPerStoreLevel -
  postEventCoffeeOption.netProfitPerHourPerStoreLevel;
const dieselBaselineAdvantage =
  dieselOption.netProfitPerHourPerStoreLevel -
  baselineCoffeeOption.netProfitPerHourPerStoreLevel;
const powderEventEndsAtUtc = "2026-07-27T00:00:00.000Z";
const beanEventEndsAtUtc = "2026-08-03T00:00:00.000Z";
const millUpgrade = state.buildings.find(
  (building) => building.kindLetter === "i" && building.busy?.type === "construction",
);
const recommendedMinimumAdvantagePercent = 0.2;
const recommendedMaximumPaybackDays = 7;

const decisionResults = {
  generatedAtUtc: new Date().toISOString(),
  recommendation: "Do not pivot now",
  confidence: "Share with caveats",
  sourceFreshness: {
    marketSnapshotAtUtc: marketSnapshot.capturedAtUtc,
    companyStateAtUtc: state.t,
  },
  company: {
    cash: state.money,
    debtPrincipal: state.bonds?.principalOutstanding ?? null,
    dailyInterest: state.bonds?.dailyInterest ?? null,
    standardBuildings: state.usedSlots ?? standardBuildings,
    millLevels,
    activeMillLevels,
    groceryLevel,
    freeStandardSlots: state.freeSlots,
  },
  liveOrder,
  liveCoffeeUnitCost,
  liveMillWagesPerHour,
  currentCoffeeOption,
  postEventCoffeeOption,
  baselineCoffeeOption,
  dieselOption,
  options,
  companyScenarios,
  decisionEconomics: {
    dieselPaperAdvantagePerHourPerStoreLevel: dieselPaperAdvantage,
    dieselPaperAdvantagePercent:
      dieselPaperAdvantage /
      postEventCoffeeOption.netProfitPerHourPerStoreLevel,
    dieselBaselineAdvantagePerHourPerStoreLevel: dieselBaselineAdvantage,
    dieselBaselineAdvantagePercent:
      dieselBaselineAdvantage /
      baselineCoffeeOption.netProfitPerHourPerStoreLevel,
    switchingCostPaybackScenarios: [10000, 30000, 50000].map(
      (switchingCost) => ({
        switchingCost,
        paybackHoursAtPaperAdvantage: switchingCost / dieselPaperAdvantage,
      }),
    ),
  },
  pivotTiming: {
    millUpgradeEndsAtUtc: millUpgrade?.busy?.endsAt ?? null,
    powderEventEndsAtUtc,
    earliestLowConfidenceCycleReviewAtUtc: "2026-07-27T01:42:00.000Z",
    observationWindowHours: 24,
    earliestDecisionReviewAtUtc: addHours(powderEventEndsAtUtc, 24),
    earliestDecisionReviewAtChicago: "2026-07-27T19:00:00-05:00",
    beanEventEndsAtUtc,
    baselineFollowupReviewAtUtc: addHours(beanEventEndsAtUtc, 24),
    baselineFollowupReviewAtChicago: "2026-08-03T19:00:00-05:00",
    recommendedGuardrails: {
      minimumVerifiedCompanyProfitAdvantagePercent:
        recommendedMinimumAdvantagePercent,
      maximumCompanyLevelPaybackDays: recommendedMaximumPaybackDays,
      minimumStableSnapshotCount: 2,
      minimumCashAfterTransition: state.config?.minCash ?? 5000,
      requiresIntegerBuildingPlan: true,
      requiresCurrentTransitionQuotes: true,
      requiresCurrentAdministrationOverhead: true,
    },
    currentEvidenceMeetsRecommendedAdvantageGuardrail:
      dieselPaperAdvantage /
        postEventCoffeeOption.netProfitPerHourPerStoreLevel >=
      recommendedMinimumAdvantagePercent,
  },
  event: {
    powderModifierPercent: -23,
    endsAtUtc: powderEventEndsAtUtc,
    endsAtChicago: "2026-07-26T19:00:00-05:00",
    beanModifierPercent: 21,
    beanEndsAtUtc: beanEventEndsAtUtc,
    beanEndsAtChicago: "2026-08-02T19:00:00-05:00",
  },
  assumptions: {
    economyState: 1,
    salaryMid,
    administrationOverhead,
    permanentProductionModifierPercent: permanentProductionModifier,
    permanentSalesModifierPercent: permanentSalesModifier,
    miningAbundance,
    quality: 0,
    weatherAppliedToPermanentGoods: false,
    debtInterestIncludedInOptionProfit: false,
    capitalAndDowntimeIncludedInOptionProfit: false,
  },
};

fs.writeFileSync(paths.output, `${JSON.stringify(decisionResults, null, 2)}\n`);
console.log(JSON.stringify(decisionResults, null, 2));
