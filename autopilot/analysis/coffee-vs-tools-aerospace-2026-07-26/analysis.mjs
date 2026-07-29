import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const simRoot = path.resolve(directory, "../../..");
const state = JSON.parse(fs.readFileSync(path.join(simRoot, "autopilot/.state.json"), "utf8"));
const facts = JSON.parse(fs.readFileSync(path.join(simRoot, "shared/facts/game-facts.json"), "utf8"));
const market = JSON.parse(fs.readFileSync(
  path.join(simRoot, "autopilot/analysis/tools-vs-coffee-2026-07-26/market-snapshot.json"),
  "utf8",
));
const ranking = JSON.parse(fs.readFileSync(
  path.join(simRoot, "autopilot/analysis/tools-vs-coffee-2026-07-26/analysis-results.json"),
  "utf8",
));
const bundle = fs.readFileSync(path.join(simRoot, "bundle-main.js"), "utf8");

const averageSalary = 345;
const salaryMid = 700;
const miningAbundance = 0.88;
const miningKinds = new Set([10, 14, 15, 42, 44, 68, 74, 104, 105]);
const permanentProductionModifier = market.permanentModifiersSource.productionPercent;
const permanentSalesModifier = market.permanentModifiersSource.salesPercent;
const temporaryModifiers = new Map(
  market.productionModifiers.map((modifier) => [Number(modifier.kind), Number(modifier.speedModifier)]),
);
const retailModelsStartMarker = "'),1:JSON.parse('";
const retailModelsStart = bundle.indexOf(retailModelsStartMarker) + retailModelsStartMarker.length;
const retailModelsEnd = bundle.indexOf("')},kKe", retailModelsStart);
const retailModelsSource = bundle.slice(retailModelsStart, retailModelsEnd);

const cashFloor = 5_000;
// The user-provided Finance screenshot showed $165,000 in the offer field while $110,000 had
// already sold. The current bundle computes the maximum as floor(building value / $5,000)
// minus sold $5,000 units. This is an optimistic ceiling, not proof that an offer will persist
// or sell; the current action driver has not verified either condition.
const observedMaximumNewBondOffer = 165_000;
const latestMillUpgradeQuote = 62_240;

function rounded(value, digits = 2) {
  return Number(value.toFixed(digits));
}

function salaryModifier(buildingLetter) {
  return Math.round((facts.buildings[buildingLetter].wage / averageSalary) * 10) / 10;
}

function productionRate(kind) {
  const resource = facts.resources[String(kind)];
  const abundance = miningKinds.has(Number(kind)) ? miningAbundance : 1;
  const temporaryModifier = temporaryModifiers.get(Number(kind)) ?? 0;
  return (
    resource.ratePerHourRaw *
    (averageSalary / salaryMid) ** salaryModifier(resource.producedAt) *
    abundance *
    (1 + temporaryModifier / 100) /
    (1 - permanentProductionModifier / 100)
  );
}

function productionLevelsPerUnitHour(kind, multiplier = 1, totals = new Map()) {
  const resource = facts.resources[String(kind)];
  totals.set(
    resource.producedAt,
    (totals.get(resource.producedAt) ?? 0) + multiplier / productionRate(kind),
  );
  for (const [inputKind, quantity] of Object.entries(resource.recipe)) {
    productionLevelsPerUnitHour(Number(inputKind), multiplier * Number(quantity), totals);
  }
  return totals;
}

function cumulativeCost(buildingLetter, level) {
  if (level <= 0) return 0;
  const baseCost = Number(facts.buildings[buildingLetter].levels["1"].approxCost);
  return Math.round(baseCost * (1 + level * (level - 1) / 2));
}

function targetLayout(kind, storeLevel = 1, forcedProductionLevel = null) {
  const candidate = ranking.candidates.find((row) => Number(row.kind) === Number(kind));
  const perUnit = productionLevelsPerUnitHour(kind);
  const production = [...perUnit.entries()].map(([letter, levelsPerUnitHour]) => {
    const fractionalLevel = levelsPerUnitHour * candidate.unitsPerHourPerStoreLevel * storeLevel;
    const integerLevel = forcedProductionLevel ?? Math.ceil(fractionalLevel - 1e-12);
    return {
      letter,
      building: facts.buildings[letter].name,
      fractionalLevel: rounded(fractionalLevel, 4),
      integerLevel,
      capexFromScratch: cumulativeCost(letter, integerLevel),
    };
  });
  const store = {
    letter: candidate.store,
    building: facts.buildings[candidate.store].name,
    fractionalLevel: storeLevel,
    integerLevel: storeLevel,
    capexFromScratch: cumulativeCost(candidate.store, storeLevel),
  };
  return {
    kind,
    product: candidate.product,
    storeLevel,
    production,
    store,
    slots: production.length + 1,
    productionIntegerLevels: production.reduce((sum, row) => sum + row.integerLevel, 0),
    totalCapexFromScratch: production.concat(store)
      .reduce((sum, row) => sum + row.capexFromScratch, 0),
    fullyFedModeledProfitPerHour: candidate.netProfitPerHourPerStoreLevel * storeLevel,
  };
}

function capacityForLevels(kind, levelsByBuilding) {
  const requirements = productionLevelsPerUnitHour(kind);
  return Math.min(...[...requirements.entries()].map(
    ([letter, levelsPerUnitHour]) => Number(levelsByBuilding[letter] ?? 0) / levelsPerUnitHour,
  ));
}

function loadRetailModel(kind) {
  const match = retailModelsSource.match(new RegExp(`"${kind}":(\\{[^{}]+\\})`));
  if (!match) throw new Error(`Retail model not found for kind ${kind}`);
  return JSON.parse(match[1]);
}

function retailUnitsPerHourPerLevel(store, kind, price) {
  const model = loadRetailModel(kind);
  const row = market.retail.find((item) => Number(item.kind) === Number(kind) && item.quality === null);
  const demandFactor = Math.min(Math.max(2 - Number(row.saturation), 0), 2);
  const priceFactor = Math.max(0.9, demandFactor / 2 + 0.5);
  const storeCurveFactor = store === "B" ? 2.28 : 1;
  const variableCost = 370 *
    (model.buildingLevelsNeededPerUnitPerHour * model.modeledUnitsSoldAnHour + 1) *
    storeCurveFactor * (demandFactor / 2);
  const modeledUnits = model.modeledUnitsSoldAnHour * priceFactor;
  const modeledPrice = model.modeledProductionCostPerUnit +
    (variableCost + (model.modeledStoreWages ?? 0)) / modeledUnits;
  const curve = variableCost -
    (price - modeledPrice) ** 2 *
    (((model.modeledStoreWages ?? 0) + variableCost) /
      (modeledPrice - model.modeledProductionCostPerUnit) ** 2);
  const seconds = (
    (100 * (price - model.modeledProductionCostPerUnit) * 3600 -
      (model.modeledStoreWages ?? 0)) /
    (curve + (model.modeledStoreWages ?? 0))
  ) * (1 - permanentSalesModifier / 100);
  return Number.isFinite(seconds) && seconds > 0
    ? (100 * 3600 / seconds) * Number(market.weather.sellingSpeedMultiplier)
    : 0;
}

function constrainedRetailProfit(kind, storeLevel, productionCapacity) {
  const candidate = ranking.candidates.find((row) => Number(row.kind) === Number(kind));
  const storeWage = averageSalary * salaryModifier(candidate.store) *
    Number(market.company.administrationOverhead) * storeLevel;
  let best = null;
  const step = kind === 99 ? 1 : 0.01;
  const upperPrice = kind === 99 ? 200_000 : 300;
  for (let price = candidate.ownCost; price <= upperPrice; price += step) {
    const unconstrainedUnits = retailUnitsPerHourPerLevel(candidate.store, kind, price) * storeLevel;
    const units = Math.min(productionCapacity, unconstrainedUnits);
    const profit = (price - candidate.ownCost) * units - storeWage;
    if (!best || profit > best.profitPerHour) {
      best = { price, unitsPerHour: units, unconstrainedUnitsPerHour: unconstrainedUnits, profitPerHour: profit };
    }
  }
  return {
    price: rounded(best.price),
    unitsPerHour: rounded(best.unitsPerHour, 4),
    profitPerHour: rounded(best.profitPerHour),
  };
}

function currentBuildingsByLetter() {
  const totals = {};
  for (const building of state.buildings) {
    if (building.category === "seasonal") continue;
    totals[building.kindLetter] = (totals[building.kindLetter] ?? 0) + Number(building.size);
  }
  return totals;
}

function incrementalCapex(layout, reusableLevels) {
  return layout.production.concat(layout.store).reduce((sum, row) => {
    const currentLevel = Number(reusableLevels[row.letter] ?? 0);
    return sum + Math.max(0,
      cumulativeCost(row.letter, row.integerLevel) - cumulativeCost(row.letter, currentLevel),
    );
  }, 0);
}

function salvageValue(buildings) {
  return buildings.reduce(
    (sum, building) => sum + cumulativeCost(building.kindLetter, Number(building.size)),
    0,
  );
}

const currentLevels = currentBuildingsByLetter();
const coffeeCapacityAfterCurrentConstruction = capacityForLevels(119, {
  i: 6,
  P: currentLevels.P,
  W: currentLevels.W,
  E: currentLevels.E,
});
const currentCoffeeEconomics = constrainedRetailProfit(
  119,
  currentLevels.G,
  coffeeCapacityAfterCurrentConstruction,
);
const coffeeCapacityWithOneNewFarm = capacityForLevels(119, {
  i: 6,
  P: currentLevels.P + 1,
  W: currentLevels.W,
  E: currentLevels.E,
});
const coffeeWithOneNewFarmEconomics = constrainedRetailProfit(
  119,
  currentLevels.G,
  coffeeCapacityWithOneNewFarm,
);
const toolsLayout = targetLayout(110, 1);
const toolsLevelOneLayout = targetLayout(110, 1, 1);
const satelliteLayout = targetLayout(99, 1);
const satelliteLevelOneLayout = targetLayout(99, 1, 1);
const reusable = { E: currentLevels.E, W: currentLevels.W, P: currentLevels.P };
const coffeeSpecific = state.buildings.filter((building) =>
  ["i", "G", "P"].includes(building.kindLetter),
);
const mills = coffeeSpecific.filter((building) => building.kindLetter === "i");
const toolsGrossIncremental = incrementalCapex(toolsLayout, reusable);
const toolsLevelOneGrossIncremental = incrementalCapex(toolsLevelOneLayout, reusable);
const satelliteGrossIncremental = incrementalCapex(satelliteLayout, reusable);
const satelliteLevelOneGrossIncremental = incrementalCapex(satelliteLevelOneLayout, reusable);
const millSalvage = salvageValue(mills);
const allCoffeeSpecificSalvage = salvageValue(coffeeSpecific);
const optimisticDeployableFunds = state.money + observedMaximumNewBondOffer - cashFloor;
const toolsLevelOneCapacity = capacityForLevels(110, {
  x: 1, L: 1, Y: 1, E: Math.max(1, currentLevels.E), Q: 1,
  M: 1, W: Math.max(1, currentLevels.W), P: Math.max(1, currentLevels.P),
});
const satelliteLevelOneCapacity = capacityForLevels(99, {
  8: 1, D: 1, E: 1, L: 1, M: 1, Q: 1, W: 1, Y: 1,
});
const toolsLevelOneEconomics = constrainedRetailProfit(110, 1, toolsLevelOneCapacity);
const satelliteLevelOneEconomics = constrainedRetailProfit(99, 1, satelliteLevelOneCapacity);

const options = [
  {
    key: "coffee_continue",
    option: "Continue the post-construction Coffee chain",
    slotsRequired: 7,
    capitalNeed: 0,
    capitalBasis: "Uses the current buildings after the third Mill finishes its current L1→L2 construction.",
    optimisticFundingGap: -optimisticDeployableFunds,
    modeledProfitPerHour: currentCoffeeEconomics.profitPerHour,
    outputPerHour: currentCoffeeEconomics.unitsPerHour,
    evidenceLevel: "Live chain plus corrected current-market model",
    decision: "KEEP",
  },
  {
    key: "coffee_add_farm",
    option: "Continue Coffee and add one L1 Farm",
    slotsRequired: 8,
    capitalNeed: cumulativeCost("P", 1),
    capitalBasis: "Current measured approximate L1 Farm construction cost; obtain a live quote before building.",
    optimisticFundingGap: cumulativeCost("P", 1) - optimisticDeployableFunds,
    modeledProfitPerHour: coffeeWithOneNewFarmEconomics.profitPerHour,
    outputPerHour: coffeeWithOneNewFarmEconomics.unitsPerHour,
    evidenceLevel: "Existing live Coffee chain plus formula scenario; new administration overhead is not re-quoted",
    decision: "BEST NEXT QUOTE",
  },
  {
    key: "tools_level_one",
    option: "Minimum L1 Tools chain while retaining Grocery",
    slotsRequired: 10,
    capitalNeed: toolsLevelOneGrossIncremental - millSalvage,
    capitalBasis: "Best-case material offset from scrapping all three Mills; salvage is not cash.",
    optimisticFundingGap: toolsLevelOneGrossIncremental - millSalvage - optimisticDeployableFunds,
    modeledProfitPerHour: toolsLevelOneEconomics.profitPerHour,
    outputPerHour: toolsLevelOneEconomics.unitsPerHour,
    evidenceLevel: "Formula only; no live Tools building or retail order",
    decision: "REJECT AS PIVOT",
  },
  {
    key: "tools_fully_fed",
    option: "Fully feed one L1 Hardware store with Tools",
    slotsRequired: toolsLayout.slots,
    capitalNeed: toolsGrossIncremental - millSalvage,
    capitalBasis: "Retains Grocery and reuses Power, Water, and Farm; material salvage is optimistic.",
    optimisticFundingGap: toolsGrossIncremental - millSalvage - optimisticDeployableFunds,
    modeledProfitPerHour: rounded(toolsLayout.fullyFedModeledProfitPerHour),
    outputPerHour: rounded(ranking.comparison.tools.unitsPerHourPerStoreLevel, 4),
    evidenceLevel: "Formula only; excludes transition downtime and new interest",
    decision: "FUTURE CANDIDATE",
  },
  {
    key: "satellite_level_one",
    option: "Minimum all-L1 Satellite chain",
    slotsRequired: satelliteLevelOneLayout.slots,
    capitalNeed: satelliteLevelOneGrossIncremental - allCoffeeSpecificSalvage,
    capitalBasis: "Most pivot-friendly case: tears down every Coffee-specific building and treats all salvage as purchase offset.",
    optimisticFundingGap: satelliteLevelOneGrossIncremental - allCoffeeSpecificSalvage - optimisticDeployableFunds,
    modeledProfitPerHour: satelliteLevelOneEconomics.profitPerHour,
    outputPerHour: satelliteLevelOneEconomics.unitsPerHour,
    evidenceLevel: "High-uncertainty formula only; output is one Satellite about every 21.9 hours",
    decision: "REJECT",
  },
  {
    key: "satellite_fully_fed",
    option: "Fully feed one L1 Sales Office with Satellite",
    slotsRequired: satelliteLayout.slots,
    capitalNeed: satelliteGrossIncremental - allCoffeeSpecificSalvage,
    capitalBasis: "Requires 54 upstream production levels; levels above L6 use the observed linear cost curve, not live quotes.",
    optimisticFundingGap: satelliteGrossIncremental - allCoffeeSpecificSalvage - optimisticDeployableFunds,
    modeledProfitPerHour: rounded(satelliteLayout.fullyFedModeledProfitPerHour),
    outputPerHour: rounded(ranking.candidates.find((row) => row.kind === 99).unitsPerHourPerStoreLevel, 4),
    evidenceLevel: "Screening model only; not financeable or live-tested",
    decision: "REJECT",
  },
];

const structurallyInfeasibleAerospace = ranking.candidates
  .filter((row) => row.store === "B" && row.kind !== 99 && row.minimumSlots > state.slotCapacity)
  .map((row) => ({ kind: row.kind, product: row.product, minimumSlots: row.minimumSlots }));

const result = {
  generatedAtUtc: new Date().toISOString(),
  sourceStateAsOfUtc: state.t,
  sourceMarketAsOfUtc: market.capturedAtUtc,
  confidence: "Share with caveats",
  company: {
    cash: state.money,
    debtPrincipal: state.bonds.principalOutstanding,
    dailyInterest: state.bonds.dailyInterest,
    slotCapacity: state.slotCapacity,
    usedSlots: state.usedSlots,
    freeSlots: state.freeSlots,
    cashFloor,
    observedMaximumNewBondOffer,
    optimisticDeployableFunds,
    bondOfferPersistenceVerified: false,
  },
  currentCoffee: {
    sustainablePowderPerHourAfterCurrentConstruction: rounded(coffeeCapacityAfterCurrentConstruction, 4),
    constrainedRetail: currentCoffeeEconomics,
    sustainablePowderPerHourWithOneNewFarm: rounded(coffeeCapacityWithOneNewFarm, 4),
    oneNewFarmConstrainedRetail: coffeeWithOneNewFarmEconomics,
    approximateNewFarmCost: cumulativeCost("P", 1),
    latestMillUpgradeQuote,
    threeMillUpgradeProgramCost: latestMillUpgradeQuote * 3,
  },
  tools: {
    fullyFedLayout: toolsLayout,
    levelOneLayout: toolsLevelOneLayout,
    levelOneCapacityPerHour: rounded(toolsLevelOneCapacity, 4),
    levelOneEconomics: toolsLevelOneEconomics,
    grossIncrementalCapex: toolsGrossIncremental,
    threeMillMaterialSalvage: millSalvage,
  },
  satellite: {
    fullyFedLayout: satelliteLayout,
    levelOneLayout: satelliteLevelOneLayout,
    levelOneCapacityPerHour: rounded(satelliteLevelOneCapacity, 6),
    levelOneHoursPerUnit: rounded(1 / satelliteLevelOneCapacity, 2),
    levelOneEconomics: satelliteLevelOneEconomics,
    grossIncrementalCapex: satelliteGrossIncremental,
    allCoffeeSpecificMaterialSalvage: allCoffeeSpecificSalvage,
  },
  options,
  structurallyInfeasibleAerospace,
  assumptions: {
    quality: 0,
    averageSalary,
    administrationOverhead: market.company.administrationOverhead,
    weatherSellingSpeedMultiplier: market.weather.sellingSpeedMultiplier,
    productionAndSalesModifiersAsOfMarketSnapshot: true,
    scrapOffsetAssumesAllReturnedMaterialsAvoidEquivalentPurchases: true,
    observedBondHeadroomIsAnOptimisticCeilingNotVerifiedCash: true,
    capexAboveLevelSixUsesObservedLinearUpgradeCurve: true,
  },
};

fs.writeFileSync(path.join(directory, "decision-results.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true,
  generatedAtUtc: result.generatedAtUtc,
  currentCoffee: result.currentCoffee,
  options: result.options.map(({ key, capitalNeed, optimisticFundingGap, modeledProfitPerHour }) => ({
    key, capitalNeed, optimisticFundingGap, modeledProfitPerHour,
  })),
}, null, 2));
