'use strict';

const {
  ACTION_NAMES,
  chatCompletionsActionTools,
  responsesActionTools,
  validateActionParams,
} = require('../../../autopilot/action-contracts.js');
const { currentMemorySchema, validateCurrentMemory } = require('../../../autopilot/current-memory.js');
const { journalToolSchema, prepareJournalEntry } = require('../../../autopilot/journal-entry.js');
const { compareMillUpgradeCandidates } = require('../../../autopilot/mill-upgrade-policy.js');
const { resolveChatMode } = require('../../../autopilot/chat/runtime-mode.js');
const { sha256 } = require('./snapshot.js');

const ACTION_SET = new Set(ACTION_NAMES);
const READ_ONLY_ACTIONS = new Set([
  'auction_info',
  'chat_contact_list',
  'chat_contact_read',
  'chat_contract_list',
  'chat_contract_preview',
  'chat_leads',
  'chat_private_read',
  'chat_private_retry_assess',
  'chat_room_read',
  'chat_room_scroll',
  'chat_rooms_discover',
  'chat_scan',
  'chat_subscription_list',
  'pa_read',
]);

const CONFIRM_PREVIEW_ACTIONS = new Set([
  'bonds',
  'build',
  'chat_contact_manage',
  'chat_contact_note',
  'chat_contact_report',
  'chat_message_retract',
  'chat_message_translate',
  'chat_post',
  'chat_private_send',
  'chat_room_post',
  'chat_room_reply',
  'chat_subscription_toggle',
  'contract_send',
  'exchange_sell',
  'rebuild',
  'robots',
  'scrap',
  'upgrade',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function removeStrict(tool) {
  const result = clone(tool);
  if (result.function) delete result.function.strict;
  return result;
}

function operationalTools() {
  return [
    {
      type: 'function',
      function: {
        name: 'refresh_state',
        description: 'Re-capture the live game state.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    {
      type: 'function',
      function: {
        name: 'set_alarm',
        description: 'Schedule the next wake. atIso must be 2 minutes to 4 hours in the future.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            atIso: { type: 'string', minLength: 1 },
            reason: { type: 'string', minLength: 1, maxLength: 500 },
          },
          required: ['atIso', 'reason'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'journal',
        description: 'Write the concise CEO decision brief after refresh_state and set_alarm.',
        parameters: journalToolSchema,
      },
    },
    {
      type: 'function',
      function: {
        name: 'master',
        description: 'Append one audit line and atomically replace CURRENT memory after set_alarm.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 1200 },
            current: currentMemorySchema,
          },
          required: ['text', 'current'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_api',
        description: 'Read a game API path with explicit source and pagination metadata.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            path: { type: 'string' },
            pointer: { type: 'string' },
            offset: { type: 'integer', minimum: 0 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
          required: ['path'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'inspect_building',
        description: 'Read one building page and optionally quote one quantity without starting it.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            buildingId: { type: 'integer', minimum: 1 },
            product: { type: ['string', 'null'] },
            qty: { type: ['number', 'null'], exclusiveMinimum: 0 },
          },
          required: ['buildingId', 'product', 'qty'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'inspect_exchange_sale',
        description: 'Read-only reserve, order-book, fee, Transport, and unsubmitted UI-form check.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'integer', minimum: 1 },
            qty: { type: ['integer', 'null'], minimum: 1 },
          },
          required: ['kind', 'qty'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'rank_mill_upgrades',
        description: 'Compare evidence-backed next-step Mill upgrades without considering current cash.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            candidates: {
              type: 'array',
              minItems: 2,
              maxItems: 3,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  buildingId: { type: 'integer', minimum: 1 },
                  currentLevel: { type: 'integer', minimum: 1, maximum: 2 },
                  currentRate: { type: 'number', exclusiveMinimum: 0 },
                  productionIncreasePct: { type: 'number', exclusiveMinimum: 0 },
                  cashCost: { type: 'number', exclusiveMinimum: 0 },
                  downtimeHours: { type: 'number', exclusiveMinimum: 0 },
                  evidenceAsOf: { type: 'string', minLength: 1 },
                },
                required: [
                  'buildingId',
                  'currentLevel',
                  'currentRate',
                  'productionIncreasePct',
                  'cashCost',
                  'downtimeHours',
                  'evidenceAsOf',
                ],
              },
            },
          },
          required: ['candidates'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'council',
        description: 'Have CFO, COO, and CMO independently review a structural proposal.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            proposal: { type: 'string' },
            context: { type: 'string' },
            buildingId: { type: ['integer', 'null'], minimum: 1 },
            marketKinds: {
              type: 'array',
              minItems: 1,
              maxItems: 5,
              items: { type: 'integer', minimum: 1 },
            },
          },
          required: ['proposal', 'context', 'buildingId', 'marketKinds'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'finish',
        description: 'End this shadow wake with a short summary after the enforced close sequence.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: { summary: { type: 'string', minLength: 1, maxLength: 1000 } },
          required: ['summary'],
        },
      },
    },
  ];
}

function buildDeepSeekTools(environment = process.env) {
  const actionTools = chatCompletionsActionTools({
    chatMode: resolveChatMode(environment),
  }).map(removeStrict);
  return [...actionTools, ...operationalTools()];
}

function buildOpenAIResponsesTools(environment = process.env) {
  const actions = responsesActionTools({
    chatMode: resolveChatMode(environment),
  });
  const operations = operationalTools().map(tool => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: clone(tool.function.parameters),
  }));
  return [...actions, ...operations];
}

function simulatedUnknown(name, reason) {
  return {
    ok: false,
    simulation: true,
    executed: false,
    readOnly: true,
    status: 'UNKNOWN',
    tool: name,
    reason,
  };
}

function normalizedProduct(value) {
  const name = String(value || '').trim().toLowerCase();
  if (['coffee ground', 'coffee grounds', 'coffee powder'].includes(name)) return 'coffee powder';
  return name;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

class ShadowToolRuntime {
  constructor(snapshot) {
    this.snapshot = clone(snapshot);
    this.currentState = clone(snapshot.state);
    this.actions = [];
    this.alarm = null;
    this.journal = null;
    this.journalEntry = null;
    this.master = null;
    this.finished = false;
    this.finishSummary = null;
    this.dirtyAfterMutation = false;
    this.refreshCount = 0;
    this.exchangeInspections = new Map();
  }

  touchState(atIso) {
    this.currentState.t = atIso;
    for (const source of Object.values(this.currentState.sources || {})) {
      if (source && typeof source === 'object' && Object.hasOwn(source, 'asOf')) {
        source.asOf = atIso;
      }
    }
    if (this.currentState?.surplusPlan) this.currentState.surplusPlan.asOf = atIso;
  }

  nextMutationTime() {
    const current = Date.parse(this.currentState?.t || this.snapshot.capturedAt);
    const baseline = Date.parse(this.snapshot.capturedAt);
    return new Date(Math.max(current, baseline) + 30e3).toISOString();
  }

  operationFixture(name, args) {
    return (this.snapshot.fixtures?.operations || []).find(fixture => (
      fixture?.action === name
        && Number(fixture?.buildingId) === Number(args?.buildingId)
    )) || null;
  }

  stockItem(kind) {
    return (this.currentState?.stock || [])
      .find(item => Number(item?.kind) === Number(kind)) || null;
  }

  validateOperation(name, args) {
    const fixture = this.operationFixture(name, args);
    if (!fixture) {
      return {
        ok: false,
        reason: `the controlled scenario has no ${name} fixture for building ${Number(args?.buildingId)}`,
      };
    }
    if (normalizedProduct(args?.name) !== normalizedProduct(fixture.name)) {
      return {
        ok: false,
        reason: `${name} must use fixture product ${fixture.name}`,
      };
    }
    const qty = finitePositive(args?.qty);
    if (qty == null || qty > Number(fixture.maxQty) + 1e-6) {
      return {
        ok: false,
        reason: `${name} quantity exceeds the controlled feasible maximum ${fixture.maxQty}`,
      };
    }
    if (name === 'produce') {
      const rate = finitePositive(fixture.ratePerHour);
      const durationHours = rate == null ? null : qty / rate;
      const targetHours = args?.targetHours == null ? null : Number(args.targetHours);
      if (durationHours != null && targetHours != null && durationHours > targetHours + 1e-6) {
        return {
          ok: false,
          reason: `production duration ${durationHours.toFixed(3)}h exceeds targetHours ${targetHours}`,
        };
      }
      const input = this.stockItem(fixture.inputKind);
      const needed = qty * Number(fixture.inputPerOutput);
      const available = Number(input?.availableAmount ?? input?.amount);
      if (!(available >= needed)) {
        return {
          ok: false,
          reason: `production requires ${needed} ${fixture.inputName}; only ${available || 0} is available`,
        };
      }
      const finishBefore = args?.finishBefore == null ? null : Date.parse(args.finishBefore);
      if (finishBefore != null && durationHours != null) {
        const startsAt = Date.parse(this.nextMutationTime());
        if (startsAt + durationHours * 60 * 60e3 > finishBefore) {
          return {
            ok: false,
            reason: 'the controlled production order would cross finishBefore',
          };
        }
      }
    }
    if (name === 'sell') {
      const item = this.stockItem(fixture.inventoryKind);
      const available = Number(item?.availableAmount ?? item?.amount);
      if (!(available >= qty)) {
        return {
          ok: false,
          reason: `retail sale requires ${qty} ${fixture.name}; only ${available || 0} is available`,
        };
      }
    }
    return { ok: true, fixture, qty };
  }

  applyOperationMutation(name, args, validation) {
    const { fixture, qty } = validation;
    const building = (this.currentState.buildings || [])
      .find(candidate => Number(candidate?.id) === Number(fixture.buildingId));
    if (!building) return null;
    const startedAt = this.nextMutationTime();
    const durationHours = name === 'produce'
      ? qty / Number(fixture.ratePerHour)
      : qty / Number(fixture.unitsPerHour);
    const endsAt = new Date(Date.parse(startedAt) + durationHours * 60 * 60e3).toISOString();
    if (name === 'produce') {
      const input = this.stockItem(fixture.inputKind);
      const required = qty * Number(fixture.inputPerOutput);
      input.amount = Number((Number(input.amount) - required).toFixed(6));
      input.availableAmount = Number((Number(input.availableAmount) - required).toFixed(6));
      building.busy = {
        id: null,
        type: 'production',
        rawCategory: 'r',
        makingKind: Number(fixture.outputKind),
        makingName: fixture.name,
        amount: qty,
        remainingOrUncollectedAmount: qty,
        amountSemantics: 'live-remaining-or-uncollected',
        amountAvailableNow: 0,
        remainingProfit: null,
        profitAvailableNow: null,
        price: null,
        expanding: false,
        canFetch: false,
        startedAt,
        endsAt,
      };
    } else {
      const item = this.stockItem(fixture.inventoryKind);
      item.amount = Number((Number(item.amount) - qty).toFixed(6));
      item.availableAmount = Number((Number(item.availableAmount) - qty).toFixed(6));
      building.busy = {
        id: null,
        type: 'sale',
        rawCategory: 's',
        makingKind: Number(fixture.inventoryKind),
        makingName: fixture.name,
        amount: qty,
        remainingOrUncollectedAmount: null,
        amountSemantics: 'sales-order-remaining',
        amountAvailableNow: null,
        remainingProfit: Number((qty * Number(fixture.profitPerUnit)).toFixed(2)),
        profitAvailableNow: 0,
        price: Number(fixture.optimizedPrice),
        expanding: false,
        canFetch: false,
        startedAt,
        endsAt,
      };
    }
    building.activity = {
      status: 'known',
      busy: true,
      type: name === 'produce' ? 'production' : 'sale',
    };
    this.touchState(startedAt);
    return {
      verified: true,
      mutationAttempted: true,
      buildingId: Number(fixture.buildingId),
      product: fixture.name,
      quantity: qty,
      startedAt,
      endsAt,
      ...(name === 'sell' ? { optimizedPrice: Number(fixture.optimizedPrice) } : {}),
    };
  }

  exchangeFixtureByName(name) {
    const fixture = this.snapshot.fixtures?.exchange;
    return fixture && normalizedProduct(fixture.name) === normalizedProduct(name) ? fixture : null;
  }

  validateExchangeAction(args) {
    const fixture = this.exchangeFixtureByName(args?.name);
    if (!fixture) return { ok: false, reason: 'the controlled scenario has no exchange fixture for this product' };
    const inspection = this.exchangeInspections.get(normalizedProduct(fixture.name));
    if (!inspection) {
      return { ok: false, reason: 'inspect_exchange_sale must succeed before the exact preview or confirmation' };
    }
    const exact = Number(args?.qty) === Number(inspection.qty)
      && Math.abs(Number(args?.price) - Number(inspection.price)) <= 1e-9;
    if (!exact) {
      return {
        ok: false,
        reason: `exchange action must exactly match inspected qty ${inspection.qty} and price ${inspection.price}`,
      };
    }
    const plan = this.currentState?.surplusPlan?.items?.[String(fixture.kind)];
    const item = this.stockItem(fixture.kind);
    if (Number(plan?.sellable) < Number(args.qty)
        || Number(item?.availableAmount ?? item?.amount) < Number(args.qty)) {
      return { ok: false, reason: 'the current simulated reserve-safe quantity is no longer available' };
    }
    return { ok: true, fixture, inspection };
  }

  applyExchangeMutation(args, validation) {
    const { fixture, inspection } = validation;
    const item = this.stockItem(fixture.kind);
    const plan = this.currentState?.surplusPlan?.items?.[String(fixture.kind)];
    item.amount = Number((Number(item.amount) - Number(args.qty)).toFixed(6));
    item.availableAmount = Number((Number(item.availableAmount) - Number(args.qty)).toFixed(6));
    plan.stock = item.amount;
    plan.totalStock = item.amount;
    plan.surplus = Math.max(0, Number(plan.surplus) - Number(args.qty));
    plan.sellable = Math.max(0, Number(plan.sellable) - Number(args.qty));
    this.currentState.money = Number((
      Number(this.currentState.money) + Number(inspection.netRevenue)
    ).toFixed(2));
    const recordedAt = this.nextMutationTime();
    this.touchState(recordedAt);
    this.exchangeInspections.delete(normalizedProduct(fixture.name));
    return {
      verified: true,
      mutationAttempted: true,
      inspectionId: inspection.inspectionId,
      name: fixture.name,
      quantity: Number(args.qty),
      price: Number(args.price),
      fee: inspection.fee,
      netRevenue: inspection.netRevenue,
      profit: inspection.profit,
      transportUsed: 0,
      recordedAt,
    };
  }

  applyScenarioMutation(name, args, validation = null) {
    const fixture = this.snapshot.fixtures?.rebuild;
    if (name === 'produce' || name === 'sell') {
      return this.applyOperationMutation(name, args, validation);
    }
    if (name === 'exchange_sell') return this.applyExchangeMutation(args, validation);
    if (name !== 'rebuild' || args?.confirm !== true || !fixture
        || Number(args.buildingId) !== Number(fixture.buildingId)) return null;
    const buildingIndex = (this.currentState.buildings || [])
      .findIndex(building => Number(building?.id) === Number(fixture.buildingId));
    if (buildingIndex < 0) return null;
    const previous = this.currentState.buildings[buildingIndex];
    this.currentState.buildings[buildingIndex] = {
      ...previous,
      id: Number(fixture.rebuiltBuildingId),
      freeAndLocked: false,
      busy: {
        id: null,
        type: 'construction',
        rawCategory: 'b',
        makingKind: null,
        makingName: null,
        amount: null,
        remainingOrUncollectedAmount: null,
        amountSemantics: null,
        amountAvailableNow: null,
        remainingProfit: null,
        profitAvailableNow: null,
        price: null,
        expanding: true,
        canFetch: null,
        startedAt: fixture.startedAt,
        endsAt: fixture.completesAt,
      },
      activity: { status: 'known', busy: true, type: 'construction' },
    };
    this.touchState(fixture.startedAt);
    return {
      verified: true,
      commitClicked: true,
      mutationAttempted: true,
      rebuiltBuildingId: Number(fixture.rebuiltBuildingId),
      replacedBuildingId: Number(fixture.replacedBuildingId),
      rebuildCompletesAt: fixture.completesAt,
      prospectorProgressBefore: Number(fixture.progressBefore),
      prospectorProgressAfter: Number(fixture.progressAfter),
      prospectorProgressTarget: Number(fixture.progressTarget),
      starsAfter: Number(fixture.starsAfter),
      starsMax: Number(fixture.starsMax),
    };
  }

  actionResult(name, rawArgs) {
    const checked = validateActionParams(name, rawArgs);
    if (!checked.ok) {
      return { ok: false, guard: true, simulation: true, executed: false, reason: checked.reason };
    }
    const args = checked.params;
    if (READ_ONLY_ACTIONS.has(name)) {
      return simulatedUnknown(
        name,
        'The frozen wake snapshot has no rendered result for this browser read; a live shadow is intentionally forbidden from opening Chrome.',
      );
    }
    const preview = CONFIRM_PREVIEW_ACTIONS.has(name) && args.confirm === false;
    if (this.dirtyAfterMutation && !preview) {
      return {
        ok: false,
        guard: true,
        simulation: true,
        executed: false,
        reason: 'refresh_state is required after the latest simulated mutation before another mutation',
      };
    }
    if (name === 'collect') {
      const collectible = (this.currentState?.buildings || [])
        .some(building => building?.busy?.canFetch === true);
      if (!collectible) {
        return {
          ok: false,
          guard: true,
          simulation: true,
          executed: false,
          reason: 'the frozen state contains no authoritatively collectible building',
        };
      }
    }
    let scenarioValidation = null;
    if (name === 'produce' || name === 'sell') {
      const building = (this.currentState?.buildings || [])
        .find(candidate => Number(candidate?.id) === Number(args.buildingId));
      const provenIdle = building?.activity?.status === 'known'
        && building.activity.busy === false
        && building.freeAndLocked !== true
        && building.busy == null;
      if (!provenIdle) {
        return {
          ok: false,
          guard: true,
          simulation: true,
          executed: false,
          reason: `building ${Number(args.buildingId)} is not authoritatively idle in the frozen state`,
        };
      }
      scenarioValidation = this.validateOperation(name, args);
      if (!scenarioValidation.ok) {
        return {
          ok: false,
          guard: true,
          simulation: true,
          executed: false,
          reason: scenarioValidation.reason,
        };
      }
    }
    if (name === 'rebuild') {
      const building = (this.currentState?.buildings || [])
        .find(candidate => Number(candidate?.id) === Number(args.buildingId));
      const supported = ['quarry', 'mine', 'oil rig'].includes(
        String(building?.name || '').trim().toLowerCase(),
      ) && Number(building?.size) === 1;
      const provenIdle = building?.activity?.status === 'known'
        && building.activity.busy === false
        && building.freeAndLocked !== true
        && building.busy == null;
      if (!supported || !provenIdle) {
        return {
          ok: false,
          guard: true,
          simulation: true,
          executed: false,
          reason: supported
            ? `rebuild target ${Number(args.buildingId)} is not authoritatively idle in the frozen state`
            : `building ${Number(args.buildingId)} is not an exact level-1 Quarry, Mine, or Oil rig`,
        };
      }
      const fixture = this.snapshot.fixtures?.rebuild;
      if (!fixture || Number(args.buildingId) !== Number(fixture.buildingId)) {
        return {
          ok: false,
          guard: true,
          simulation: true,
          executed: false,
          reason: 'the controlled scenario has no rebuild fixture for this building',
        };
      }
    }
    if (name === 'exchange_sell') {
      scenarioValidation = this.validateExchangeAction(args);
      if (!scenarioValidation.ok) {
        return {
          ok: false,
          guard: true,
          simulation: true,
          executed: false,
          reason: scenarioValidation.reason,
        };
      }
    }
    const fixtureBacked = ['produce', 'sell', 'rebuild', 'exchange_sell'].includes(name);
    if (!preview && !fixtureBacked) {
      return {
        ok: false,
        guard: true,
        simulation: true,
        executed: false,
        reason: `the controlled scenario has no confirmed ${name} mutation fixture`,
      };
    }
    const record = {
      sequence: this.actions.length + 1,
      action: name,
      params: clone(args),
      preview,
      wouldClick: !preview,
      executed: false,
    };
    this.actions.push(record);
    if (!preview) this.dirtyAfterMutation = true;
    const scenarioOutcome = preview ? null : this.applyScenarioMutation(name, args, scenarioValidation);
    return {
      ok: true,
      simulation: true,
      executed: false,
      preview,
      wouldClick: !preview,
      action: name,
      params: clone(args),
      ...(scenarioOutcome || {}),
      requiredNextTool: preview ? null : 'refresh_state',
      note: preview
        ? 'Validated shadow preview only; no browser was opened.'
        : 'Validated click intent recorded. Treat this simulated receipt as success for evaluation; do not repeat it to force a live change.',
    };
  }

  inspectBuilding(args) {
    const buildingId = Number(args?.buildingId);
    const building = (this.currentState?.buildings || [])
      .find(candidate => Number(candidate?.id) === buildingId);
    if (!building) return simulatedUnknown('inspect_building', `building ${buildingId} is absent from the frozen state`);
    const millRate = this.currentState?.surplusPlan?.millCapacity?.rates
      ?.find(candidate => Number(candidate?.buildingId) === buildingId) || null;
    return {
      ok: true,
      simulation: true,
      executed: false,
      readOnly: true,
      source: 'frozen .state.json',
      asOf: this.currentState.t || this.snapshot.capturedAt,
      building: clone(building),
      millRate: clone(millRate),
      quote: args?.product == null && args?.qty == null
        ? null
        : {
            status: 'UNKNOWN',
            product: args?.product ?? null,
            qty: args?.qty ?? null,
            reason: 'A quantity quote requires the rendered building page and was not fabricated.',
          },
    };
  }

  inspectExchange(args) {
    const kind = Number(args?.kind);
    const reserve = this.currentState?.surplusPlan?.items?.[String(kind)] || null;
    if (!reserve) return simulatedUnknown('inspect_exchange_sale', `kind ${kind} has no frozen reserve record`);
    const fixture = this.snapshot.fixtures?.exchange;
    if (fixture && Number(fixture.kind) === kind) {
      const requested = args?.qty == null ? Number(fixture.recommendedQty) : Number(args.qty);
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > Number(fixture.maxQty)
          || requested > Number(reserve.sellable)) {
        return {
          ok: false,
          simulation: true,
          executed: false,
          readOnly: true,
          failClosed: true,
          reserve: clone(reserve),
          requestedQty: args?.qty ?? null,
          reason: `requested quantity must be an integer from 1 to ${Math.min(Number(fixture.maxQty), Number(reserve.sellable))}`,
        };
      }
      const grossRevenue = Number((requested * Number(fixture.price)).toFixed(6));
      const fee = Number((grossRevenue * Number(fixture.feePct)).toFixed(6));
      const netRevenue = Number((grossRevenue - fee).toFixed(6));
      const accountingCost = Number((requested * Number(fixture.unitAccountingCost)).toFixed(6));
      const profit = Number((netRevenue - accountingCost).toFixed(6));
      const inspectedAt = this.currentState.t || this.snapshot.capturedAt;
      const inspectionId = `shadow-${sha256([
        this.snapshot.scenario?.id,
        kind,
        requested,
        fixture.price,
        inspectedAt,
      ].join(':')).slice(0, 20)}`;
      const inspection = {
        inspectionId,
        inspectedAt,
        expiresAt: new Date(
          Date.parse(inspectedAt) + Number(fixture.inspectionTtlSeconds) * 1000,
        ).toISOString(),
        kind,
        name: fixture.name,
        qty: requested,
        price: Number(fixture.price),
        grossRevenue,
        fee,
        netRevenue,
        accountingCost,
        profit,
      };
      this.exchangeInspections.set(normalizedProduct(fixture.name), inspection);
      return {
        ok: true,
        simulation: true,
        executed: false,
        readOnly: true,
        source: 'controlled frozen exchange fixture',
        reserve: clone(reserve),
        inspectionId,
        inspectedAt,
        expiresAt: inspection.expiresAt,
        book: {
          live: { status: 'ok', asOf: inspectedAt },
          availableDepth: Number(fixture.availableDepth),
          exactPrice: Number(fixture.price),
        },
        uiQuote: {
          ok: true,
          mutationAttempted: false,
          name: fixture.name,
          qty: requested,
          price: Number(fixture.price),
          grossRevenue,
          fee,
          netRevenue,
          accountingCost,
          profit,
          transportRequired: 0,
        },
        exactAction: {
          name: fixture.name,
          qty: requested,
          price: Number(fixture.price),
          confirm: false,
        },
      };
    }
    return {
      ok: false,
      simulation: true,
      executed: false,
      readOnly: true,
      failClosed: true,
      reserve: clone(reserve),
      requestedQty: args?.qty ?? null,
      book: { live: { status: null, asOf: null } },
      uiQuote: {
        ok: false,
        mutationAttempted: false,
        reason: 'Live order book and rendered exchange form were intentionally not opened.',
      },
      reason: 'Snapshot reserve evidence is available, but fresh price/depth/UI evidence is UNKNOWN.',
    };
  }

  setAlarm(args) {
    const at = Date.parse(args?.atIso);
    const now = Date.parse(this.snapshot.capturedAt);
    if (!Number.isFinite(at) || !Number.isFinite(now)) {
      return { ok: false, guard: true, simulation: true, reason: 'set_alarm requires a valid atIso' };
    }
    if (typeof args?.reason !== 'string' || !args.reason.trim() || args.reason.length > 500) {
      return { ok: false, guard: true, simulation: true, reason: 'set_alarm reason must contain 1..500 characters' };
    }
    const min = now + 2 * 60e3;
    const max = now + 4 * 60 * 60e3;
    const scheduled = Math.min(Math.max(at, min), max);
    this.alarm = {
      at: scheduled,
      atIso: new Date(scheduled).toISOString(),
      reason: args.reason.trim(),
      requestedAtIso: args.atIso,
      clamped: scheduled !== at,
      simulation: true,
    };
    return {
      ok: true,
      simulation: true,
      executed: false,
      wakeAt: this.alarm.atIso,
      clamped: this.alarm.clamped,
    };
  }

  writeJournal(args) {
    if (this.dirtyAfterMutation) {
      return {
        ok: false,
        guard: true,
        simulation: true,
        reason: 'refresh_state is required after the latest simulated mutation before journal',
      };
    }
    if (!this.alarm) {
      return { ok: false, guard: true, simulation: true, reason: 'set_alarm must succeed before journal' };
    }
    const prepared = prepareJournalEntry(args, this.currentState);
    if (!prepared.ok) return { ...prepared, simulation: true };
    this.journalEntry = clone(prepared.value);
    this.journal = prepared.markdown;
    return { ok: true, simulation: true, executed: false, decisionBrief: prepared.markdown };
  }

  writeMaster(args) {
    if (!this.alarm) {
      return { ok: false, guard: true, simulation: true, reason: 'set_alarm must succeed before master' };
    }
    if (this.dirtyAfterMutation) {
      return {
        ok: false,
        guard: true,
        simulation: true,
        reason: 'refresh_state is required after the latest simulated mutation before master',
      };
    }
    const text = String(args?.text || '').trim();
    if (!text || text.length > 1200) {
      return { ok: false, guard: true, simulation: true, reason: 'master text must contain 1..1200 characters' };
    }
    const checked = validateCurrentMemory(
      args?.current,
      this.currentState,
      this.alarm,
      new Date(this.snapshot.capturedAt),
    );
    if (!checked.ok) return { ...checked, simulation: true };
    this.master = { text, current: checked.value };
    return {
      ok: true,
      simulation: true,
      executed: false,
      currentUpdatedAt: checked.value.updatedAt,
    };
  }

  finish(args) {
    const summary = String(args?.summary || '').trim();
    if (!summary || summary.length > 1000) {
      return { ok: false, guard: true, simulation: true, reason: 'finish summary must contain 1..1000 characters' };
    }
    if (this.dirtyAfterMutation) {
      return { ok: false, guard: true, simulation: true, reason: 'refresh_state is required after the latest simulated mutation' };
    }
    if (!this.alarm || !this.journal || !this.master) {
      return {
        ok: false,
        guard: true,
        simulation: true,
        reason: 'close order is refresh_state → set_alarm → journal → master → finish',
      };
    }
    this.finished = true;
    this.finishSummary = summary;
    return { ok: true, simulation: true, executed: false };
  }

  async execute(name, args = {}) {
    if (ACTION_SET.has(name)) return this.actionResult(name, args);
    if (name === 'refresh_state') {
      this.refreshCount += 1;
      this.dirtyAfterMutation = false;
      return {
        ...clone(this.currentState),
        _shadow: {
          simulation: true,
          executed: false,
          frozenAt: this.snapshot.capturedAt,
          refreshCount: this.refreshCount,
          recordedActions: clone(this.actions),
          note: 'The source snapshot is frozen; deterministic fixture outcomes are reflected in this isolated in-memory state and never touch the browser or game.',
        },
      };
    }
    if (name === 'set_alarm') return this.setAlarm(args);
    if (name === 'journal') return this.writeJournal(args);
    if (name === 'master') return this.writeMaster(args);
    if (name === 'finish') return this.finish(args);
    if (name === 'inspect_building') return this.inspectBuilding(args);
    if (name === 'inspect_exchange_sale') return this.inspectExchange(args);
    if (name === 'rank_mill_upgrades') {
      try {
        return { ...compareMillUpgradeCandidates(args?.candidates), simulation: true };
      } catch (error) {
        return { ok: false, guard: true, simulation: true, reason: String(error.message || error) };
      }
    }
    if (name === 'read_api') {
      const fixture = this.snapshot.fixtures?.prospector;
      if (fixture && String(args?.path || '') === fixture.path) {
        const rebuilt = this.actions.some(action => (
          action.action === 'rebuild'
            && action.preview === false
            && Number(action.params?.buildingId) === Number(this.snapshot.fixtures?.rebuild?.buildingId)
        ));
        const row = clone(rebuilt ? fixture.after : fixture.before);
        return {
          ok: true,
          simulation: true,
          executed: false,
          readOnly: true,
          path: fixture.path,
          status: 200,
          fetchedAt: rebuilt
            ? this.snapshot.fixtures.rebuild.startedAt
            : this.snapshot.capturedAt,
          pointer: args?.pointer || '',
          offset: Number(args?.offset) || 0,
          limit: Number(args?.limit) || 100,
          totalItems: 1,
          returnedItems: 1,
          truncated: false,
          data: args?.pointer ? row : [row],
        };
      }
      return simulatedUnknown(
        name,
        `API path ${String(args?.path || '(missing)')} was not called because this run is browser/game isolated.`,
      );
    }
    if (name === 'council') {
      return simulatedUnknown(
        name,
        'The production council would make additional model/API and browser reads; the shadow run records this as an evidence requirement instead of fabricating a verdict.',
      );
    }
    return { ok: false, guard: true, simulation: true, reason: `unknown shadow tool: ${name}` };
  }
}

module.exports = {
  CONFIRM_PREVIEW_ACTIONS,
  READ_ONLY_ACTIONS,
  ShadowToolRuntime,
  buildDeepSeekTools,
  buildOpenAIResponsesTools,
  operationalTools,
  removeStrict,
};
