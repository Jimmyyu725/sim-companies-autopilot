import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const simRoot = path.resolve(directory, "../../..");

const paths = {
  facts: path.join(simRoot, "shared/facts/game-facts.json"),
  names: path.join(simRoot, "shared/price-tracker/data/names.json"),
  bundle: path.join(simRoot, "bundle-main.js"),
  authenticatedSnapshot: path.join(
    simRoot,
    "autopilot/analysis/self-produced-retail-2026-07-26/market-snapshot.json",
  ),
  marketOutput: path.join(directory, "market-snapshot.json"),
  resultOutput: path.join(directory, "analysis-results.json"),
};

const retailStores = {
  G: [3, 4, 5, 7, 8, 9, 119, 123, 124, 125, 126, 122, 127, 140, 152],
  C: [24, 25, 26, 27, 28, 98],
  H: [60, 61, 62, 63, 64, 65, 70, 71],
  d: [102, 103, 108, 109, 110],
  A: [11, 12],
  2: [53, 54, 55, 56, 57],
  B: [91, 94, 95, 96, 97, 99],
};

const displayNames = {
  53: "Economy E-Car",
  54: "Luxury E-Car",
  63: "Stiletto Heel",
  70: "Luxury Watch",
  91: "Sub-Orbital Rocket",
  94: "BFR",
  95: "Jumbo Jet",
  96: "Luxury Jet",
  97: "Single Engine Plane",
  99: "Satellite",
  119: "Coffee Powder",
  127: "Frozen Pizza",
  152: "Ramadan Sweets",
};

const averageSalary = 345;
const salaryMid = 700;
const miningAbundance = 0.88;
const miningKinds = new Set([10, 14, 15, 42, 44, 68, 74, 104, 105]);
const salesOfficeCurveFactor = 2.28;

const facts = JSON.parse(fs.readFileSync(paths.facts, "utf8"));
const names = JSON.parse(fs.readFileSync(paths.names, "utf8"));
const bundle = fs.readFileSync(paths.bundle, "utf8");
const authenticatedSnapshot = JSON.parse(
  fs.readFileSync(paths.authenticatedSnapshot, "utf8"),
);

const permanentProductionModifier =
  authenticatedSnapshot.company.permanentProductionModifierPercent;
const permanentSalesModifier =
  authenticatedSnapshot.company.permanentSalesModifierPercent;

const retailModelsStartMarker = "'),1:JSON.parse('";
const retailModelsStart =
  bundle.indexOf(retailModelsStartMarker) + retailModelsStartMarker.length;
const retailModelsEnd = bundle.indexOf("')},kKe", retailModelsStart);
const retailModelsSource = bundle.slice(retailModelsStart, retailModelsEnd);

function productName(kind) {
  const fallback = names[String(kind)] || `kind ${kind}`;
  return displayNames[kind] || fallback.replaceAll(/\b\w/g, (letter) => letter.toUpperCase());
}

function salaryModifier(buildingLetter) {
  return (
    Math.round((facts.buildings[buildingLetter].wage / averageSalary) * 10) / 10
  );
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

function createProductionModel(temporaryModifiers, administrationOverhead) {
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

  return { ownCost, productionLevels };
}

function retailParameters(store, kind, saturation) {
  const model = loadRetailModel(kind);
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
  return { model, modeledPrice, modeledStoreWages, variableCost };
}

function retailUnitsPerHour(
  store,
  kind,
  price,
  saturation,
  weatherMultiplier,
  quantity = 100,
) {
  const { model, modeledPrice, modeledStoreWages, variableCost } =
    retailParameters(store, kind, saturation);
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
  return ((quantity * 3600) / seconds) * weatherMultiplier;
}

function optimizeRetail(
  store,
  kind,
  saturation,
  weatherMultiplier,
  productionModel,
  administrationOverhead,
) {
  const { model, modeledPrice } = retailParameters(store, kind, saturation);
  const ownCost = productionModel.ownCost(kind);
  const lowerPrice = Math.max(
    model.modeledProductionCostPerUnit + 0.01,
    ownCost,
  );
  const upperPrice =
    2 * modeledPrice - model.modeledProductionCostPerUnit - 0.01;
  if (lowerPrice > upperPrice) {
    return null;
  }
  const storeWage =
    averageSalary * salaryModifier(store) * administrationOverhead;

  function netProfit(price) {
    const units = retailUnitsPerHour(
      store,
      kind,
      price,
      saturation,
      weatherMultiplier,
    );
    return {
      units,
      profit: (price - ownCost) * units - storeWage,
    };
  }

  let left = lowerPrice;
  let right = upperPrice;
  for (let iteration = 0; iteration < 160; iteration += 1) {
    const third = (right - left) / 3;
    const first = left + third;
    const second = right - third;
    if (netProfit(first).profit < netProfit(second).profit) {
      left = first;
    } else {
      right = second;
    }
  }

  const centerCents = Math.round(((left + right) / 2) * 100);
  let best = null;
  for (
    let cents = Math.max(Math.ceil(lowerPrice * 100), centerCents - 300);
    cents <= Math.min(Math.floor(upperPrice * 100), centerCents + 300);
    cents += 1
  ) {
    const price = cents / 100;
    const result = netProfit(price);
    if (!best || result.profit > best.netProfitPerHourPerStoreLevel) {
      best = {
        price,
        unitsPerHourPerStoreLevel: result.units,
        netProfitPerHourPerStoreLevel: result.profit,
      };
    }
  }
  if (!best || best.netProfitPerHourPerStoreLevel <= 0) {
    return null;
  }

  const productionLevelsByType = productionModel.productionLevels(kind);
  const productionLevels =
    [...productionLevelsByType.values()].reduce((sum, value) => sum + value, 0) *
    best.unitsPerHourPerStoreLevel;
  const hourlyRevenue = best.price * best.unitsPerHourPerStoreLevel;

  return {
    kind,
    product: productName(kind),
    store,
    ownCost,
    ...best,
    netProfitMargin:
      best.netProfitPerHourPerStoreLevel / hourlyRevenue,
    netProfitPerUnitAfterRetailWage:
      best.netProfitPerHourPerStoreLevel / best.unitsPerHourPerStoreLevel,
    productionLevels,
    minimumSlots: productionLevelsByType.size + 1,
    profitPerTotalBuildingLevel:
      best.netProfitPerHourPerStoreLevel / (1 + productionLevels),
  };
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned HTTP ${response.status}`);
  }
  return response.json();
}

const capturedAtUtc = new Date().toISOString();
const [retail, weather, modifierPayload, companyPayload] = await Promise.all([
  getJson("https://www.simcompanies.com/api/v4/0/resources-retail-info/"),
  getJson("https://www.simcompanies.com/api/v2/weather/0/"),
  getJson("https://www.simcompanies.com/api/v2/production-modifiers/0/"),
  getJson("https://www.simcompanies.com/api/v3/companies/5714348/"),
]);

const company = companyPayload.companyPublicInfo || {};
const infrastructure = companyPayload.infrastructure || {};
const productionModifiers = modifierPayload.resourceProductionModifiers || [];
const marketSnapshot = {
  capturedAtUtc,
  company: {
    level: company.level,
    administrationOverhead: infrastructure.administrationOverhead,
    maximumBaseBuildings: company.maxBuildings,
  },
  permanentModifiersSource: {
    capturedAtUtc: authenticatedSnapshot.capturedAtUtc,
    productionPercent: permanentProductionModifier,
    salesPercent: permanentSalesModifier,
    rationale: "Company level is unchanged, so the authenticated permanent modifiers remain applicable.",
  },
  weather,
  productionModifiers,
  retail: retail.map((row) => ({
    kind: row.dbLetter,
    quality: row.quality,
    averagePrice: row.averagePrice ?? null,
    saturation: row.saturation ?? null,
    demand: row.retailData?.at(-1)?.demand ?? null,
  })),
};
fs.writeFileSync(
  paths.marketOutput,
  `${JSON.stringify(marketSnapshot, null, 2)}\n`,
  "utf8",
);

const saturationByKind = new Map(
  marketSnapshot.retail
    .filter((row) => row.quality === null)
    .map((row) => [Number(row.kind), Number(row.saturation)]),
);
const temporaryModifiers = new Map(
  productionModifiers.map((modifier) => [
    Number(modifier.kind),
    Number(modifier.speedModifier),
  ]),
);
const productionModel = createProductionModel(
  temporaryModifiers,
  infrastructure.administrationOverhead,
);

const candidates = [];
const exclusions = [];
for (const [store, kinds] of Object.entries(retailStores)) {
  for (const kind of kinds) {
    const resource = facts.resources[String(kind)];
    if (resource.retailSeason || resource.productionSeason) {
      exclusions.push({
        kind,
        product: productName(kind),
        reason: "Seasonal product",
      });
      continue;
    }
    const result = optimizeRetail(
      store,
      kind,
      saturationByKind.get(kind),
      Number(weather.sellingSpeedMultiplier),
      productionModel,
      Number(infrastructure.administrationOverhead),
    );
    if (result) {
      candidates.push(result);
    }
  }
}

candidates.sort(
  (left, right) =>
    right.netProfitPerHourPerStoreLevel -
    left.netProfitPerHourPerStoreLevel,
);
candidates.forEach((candidate, index) => {
  candidate.hourlyProfitRank = index + 1;
});

const marginRanking = [...candidates].sort(
  (left, right) => right.netProfitMargin - left.netProfitMargin,
);
marginRanking.forEach((candidate, index) => {
  candidate.marginRank = index + 1;
});

const efficiencyRanking = [...candidates].sort(
  (left, right) =>
    right.profitPerTotalBuildingLevel - left.profitPerTotalBuildingLevel,
);
efficiencyRanking.forEach((candidate, index) => {
  candidate.totalLevelEfficiencyRank = index + 1;
});

const tools = candidates.find((candidate) => candidate.kind === 110);
const coffee = candidates.find((candidate) => candidate.kind === 119);
const nonAerospace = candidates.filter((candidate) => candidate.store !== "B");

const results = {
  generatedAtUtc: capturedAtUtc,
  confidence: "Share with caveats",
  candidateCount: candidates.length,
  comparison: {
    tools,
    coffee,
    toolsNonAerospaceHourlyRank:
      nonAerospace.findIndex((candidate) => candidate.kind === 110) + 1,
    coffeeNonAerospaceHourlyRank:
      nonAerospace.findIndex((candidate) => candidate.kind === 119) + 1,
    toolsToCoffeeHourlyMultiple:
      tools.netProfitPerHourPerStoreLevel /
      coffee.netProfitPerHourPerStoreLevel,
    coffeeMarginAdvantagePercentagePoints:
      (coffee.netProfitMargin - tools.netProfitMargin) * 100,
  },
  topByHourlyProfit: candidates.slice(0, 15),
  candidates,
  exclusions,
  assumptions: {
    quality: 0,
    economyState: 1,
    averageSalary,
    salaryMid,
    miningAbundance,
    administrationOverhead: infrastructure.administrationOverhead,
    permanentProductionModifierPercent: permanentProductionModifier,
    permanentSalesModifierPercent: permanentSalesModifier,
    weatherSellingSpeedMultiplier: weather.sellingSpeedMultiplier,
    includesRecursiveSelfProductionCost: true,
    includesRetailWage: true,
    excludesCapexDowntimeDemolitionInterestTransportAndIntegerRounding: true,
  },
};

fs.writeFileSync(
  paths.resultOutput,
  `${JSON.stringify(results, null, 2)}\n`,
  "utf8",
);

console.log(
  JSON.stringify({
    ok: true,
    generatedAtUtc: capturedAtUtc,
    candidateCount: candidates.length,
    tools: {
      hourlyRank: tools.hourlyProfitRank,
      marginRank: tools.marginRank,
      netProfitPerHour: tools.netProfitPerHourPerStoreLevel,
      netProfitMargin: tools.netProfitMargin,
    },
    coffee: {
      hourlyRank: coffee.hourlyProfitRank,
      marginRank: coffee.marginRank,
      netProfitPerHour: coffee.netProfitPerHourPerStoreLevel,
      netProfitMargin: coffee.netProfitMargin,
    },
  }),
);
