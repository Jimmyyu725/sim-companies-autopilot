#!/usr/bin/env node
// Sell a warehouse item on the exchange through the game UI. Direct mutation APIs are rejected by
// the game's request-signing layer, so this standalone driver keeps navigation, selection, form
// verification, and the optional final click in one CDP session.
//
// Usage: node sell-exchange-ui.js <image-slug> <qty> <price> [--submit]
// Without --submit the exact form is filled and verified, but never submitted.
'use strict';

const path = require('path');
const cdp = require(path.join(__dirname, '..', '..', 'shared', 'cdp.js'));
const config = require(path.join(__dirname, '..', '..', 'shared', 'config.json'));
const {
  normalizeAssetSlug,
  validateExchangePostSubmit,
  validateExchangeUiReview,
} = require(path.join(__dirname, '..', 'exchange-ui-verification.js'));

const [imageSlugArg, qtyArg, priceArg, optionsArg] = process.argv.slice(2);
const ARM = process.argv.includes('--submit');
const expectedSlug = String(imageSlugArg || '').trim().toLowerCase();
const requestedQty = Number(qtyArg);
const requestedPrice = Number(priceArg);
let saleOptions = null;
try { saleOptions = JSON.parse(String(optionsArg || '')); } catch (_) {}
const expectedKind = Number(saleOptions?.kind);
const expectedReserve = saleOptions?.reserve == null || saleOptions.reserve === ''
  ? NaN : Number(saleOptions.reserve);
const expectedReserveValidUntilMs = Date.parse(saleOptions?.reserveValidUntil);
const expectedTransportPerUnit = saleOptions?.transportPerUnit == null || saleOptions.transportPerUnit === ''
  ? NaN : Number(saleOptions.transportPerUnit);
const expectedLotIndex = saleOptions?.lotIndex == null ? null : Number(saleOptions.lotIndex);
const expectedLotQuality = saleOptions?.lotQuality == null ? null : Number(saleOptions.lotQuality);
const expectedLotUnitCost = saleOptions?.lotUnitCost == null ? null : Number(saleOptions.lotUnitCost);

function finish(result, exitCode = 0) {
  console.log(JSON.stringify(result, null, 2));
  try { cdp.close(); } catch (_) {}
  process.exit(exitCode);
}

if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(expectedSlug) ||
    normalizeAssetSlug(expectedSlug) !== expectedSlug ||
    !Number.isSafeInteger(requestedQty) || requestedQty <= 0 ||
    !Number.isFinite(requestedPrice) || requestedPrice <= 0 ||
    !Number.isSafeInteger(expectedKind) || expectedKind <= 0 ||
    !Number.isFinite(expectedReserve) || expectedReserve < 0 ||
    (ARM && !Number.isFinite(expectedReserveValidUntilMs)) ||
    !Number.isFinite(expectedTransportPerUnit) || expectedTransportPerUnit < 0 ||
    (ARM && (!Number.isSafeInteger(expectedLotIndex) || expectedLotIndex < 0)) ||
    (!ARM && expectedLotIndex != null && (!Number.isSafeInteger(expectedLotIndex) || expectedLotIndex < 0)) ||
    (expectedLotQuality != null && (!Number.isSafeInteger(expectedLotQuality) || expectedLotQuality < 0)) ||
    (ARM && (!Number.isFinite(expectedLotUnitCost) || expectedLotUnitCost < 0)) ||
    (!ARM && expectedLotUnitCost != null && (!Number.isFinite(expectedLotUnitCost) || expectedLotUnitCost < 0))) {
  finish({
    ok: false,
    reason: 'usage: sell-exchange-ui.js <exact-image-slug> <positive-integer-qty> <positive-price> <verified-options-json> [--submit]',
  }, 2);
}

(async () => {
  await cdp.connect();
  await cdp.goto('https://www.simcompanies.com/headquarters/warehouse/');

  // Resolve a warehouse tile by an exact normalized asset slug. Hashed production filenames such
  // as power.8df7bb28.png normalize to power; superpower.*.png never matches power.
  const tile = await cdp.evaluate(`
    const normalizeSlug = ${normalizeAssetSlug.toString()};
    const expected = ${JSON.stringify(expectedSlug)};
    const candidates = all('img').filter(image => image.offsetParent !== null &&
      normalizeSlug(image.currentSrc || image.src || '') === expected).map(image => {
        const rect = image.getBoundingClientRect();
        return { image, rect, actualSlug: normalizeSlug(image.currentSrc || image.src || '') };
      }).filter(candidate => candidate.rect.width > 0 && candidate.rect.height > 0);
    if (!candidates.length) return { ok:false, expectedSlug:expected, reason:'exact warehouse tile not found' };
    candidates.sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height));
    const selected = candidates[0];
    let element = selected.image;
    for (let depth = 0; depth < 5 && element.parentElement; depth++) {
      if (element.getBoundingClientRect().width > 40) break;
      element = element.parentElement;
    }
    element.scrollIntoView({block:'center'});
    const rect = element.getBoundingClientRect();
    window.__exchangeTileProof = {
      expectedSlug: expected,
      actualSlug: selected.actualSlug,
      exact: selected.actualSlug === expected,
      image: selected.image,
    };
    return {
      ok: selected.actualSlug === expected,
      expectedSlug: expected,
      actualSlug: selected.actualSlug,
      exactCandidateCount: candidates.length,
      x: rect.x + rect.width / 2,
      y: rect.y + rect.height / 2,
    };
  `);
  if (!tile?.ok) return finish({ ok: false, step: 'tile', ...tile });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: tile.x, y: tile.y, button: 'left', clickCount: 1,
    });
  }
  await new Promise(resolve => setTimeout(resolve, 2600));

  // Bind the selected product panel to an exact-slug image and the exchange opener, then choose
  // one concrete quality lot that can satisfy the entire order. The DOM references remain on
  // window so the final confirmation can re-read the same product and lot immediately before click.
  const qualitySelection = await cdp.evaluate(`
    const normalizeSlug = ${normalizeAssetSlug.toString()};
    const expected = ${JSON.stringify(expectedSlug)};
    const requested = ${requestedQty};
    const expectedLotIndex = ${expectedLotIndex};
    const expectedLotQuality = ${JSON.stringify(expectedLotQuality)};
    const expectedLotUnitCost = ${JSON.stringify(expectedLotUnitCost)};
    const visible = element => element && element.offsetParent !== null;
    const exactImages = all('img').filter(image => visible(image) &&
      normalizeSlug(image.currentSrc || image.src || '') === expected);
    const openerLabels = all('button,a,[role="button"],div,span').filter(element => visible(element) &&
      /^sell on the exchange$/i.test(norm(element.innerText)));
    const openers = [...new Set(openerLabels.map(label =>
      label.closest('button,a,[role="button"]') || label))];
    const commonAncestor = (left, right) => {
      let node = left;
      while (node && !node.contains(right)) node = node.parentElement;
      return node;
    };
    const scopes = [];
    for (const image of exactImages) {
      for (const opener of openers) {
        const scope = commonAncestor(image, opener);
        if (!scope || scope === document.body || scope === document.documentElement) continue;
        const rect = scope.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) scopes.push({ scope, image, opener, area:rect.width * rect.height });
      }
    }
    scopes.sort((a, b) => a.area - b.area);
    const bound = scopes[0];
    if (!bound) return {
      ok:false,
      step:'product',
      reason:'selected product panel cannot be bound to the exact image slug and exchange control',
      requested,
      expectedSlug:expected,
      exactImageCount:exactImages.length,
      exchangeControlCount:openers.length,
      qualityChoices:[],
    };

    const amountElements = Array.from(bound.scope.querySelectorAll('b')).filter(element => visible(element) &&
      /^[\\d,]+$/.test(norm(element.innerText)));
    const choices = amountElements.map((element, index) => {
      const available = Number(norm(element.innerText).replace(/,/g, ''));
      let row = element;
      for (let depth = 0; depth < 4 && row.parentElement && row.parentElement !== bound.scope; depth++) {
        const parentText = norm(row.parentElement.innerText);
        if (parentText.length > 180) break;
        row = row.parentElement;
      }
      const rowText = norm(row.innerText).slice(0, 180);
      const qualityMatch = rowText.match(/(?:quality|\\bq)\\s*([0-9]+)/i);
      const moneyValues = [...rowText.matchAll(/\\$\\s*([\\d,.]+)/g)]
        .map(match => Number(match[1].replace(/,/g, ''))).filter(Number.isFinite);
      const unitCost = moneyValues.length ? moneyValues[moneyValues.length - 1] : null;
      const rect = element.getBoundingClientRect();
      return {
        element,
        index,
        available,
        rowText,
        quality: qualityMatch ? Number(qualityMatch[1]) : null,
        unitCost,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      };
    }).filter(choice => Number.isFinite(choice.available) && choice.available > 0);
    const selected = expectedLotIndex == null
      ? choices.find(choice => choice.available >= requested)
      : choices.find(choice => choice.index === expectedLotIndex &&
        (expectedLotQuality == null || choice.quality === expectedLotQuality) &&
        (expectedLotUnitCost == null || Math.abs(choice.unitCost - expectedLotUnitCost) < 1e-9) &&
        choice.available >= requested);
    const qualityChoices = choices.map(choice => ({
      index: choice.index,
      available: choice.available,
      quality: choice.quality,
      unitCost: choice.unitCost,
      rowText: choice.rowText,
    }));
    if (!selected) return {
      ok:false,
      step:'quality',
      reason:'no single quality lot can satisfy qty',
      requested,
      selectedProduct:{ requestedSlug:expected, actualSlug:normalizeSlug(bound.image.currentSrc || bound.image.src || ''), exact:true },
      qualityChoices,
    };

    window.__exchangeProductProof = {
      scope: bound.scope,
      image: bound.image,
      requestedSlug: expected,
      actualSlug: normalizeSlug(bound.image.currentSrc || bound.image.src || ''),
    };
    window.__exchangeSelectedLotProof = {
      amountElement: selected.element,
      index: selected.index,
      available: selected.available,
      quality: selected.quality,
      unitCost: selected.unitCost,
      rowText: selected.rowText,
    };
    return {
      ok:true,
      selectedProduct:{ requestedSlug:expected, actualSlug:window.__exchangeProductProof.actualSlug, exact:true },
      selectedLot:{ index:selected.index, available:selected.available, quality:selected.quality, unitCost:selected.unitCost, rowText:selected.rowText },
      qualityChoices,
      x:selected.x,
      y:selected.y,
    };
  `);
  if (!qualitySelection?.ok) return finish({
    ok: false,
    step: qualitySelection?.step || 'quality',
    reason: qualitySelection?.reason || 'quality selection failed',
    selectedProduct: qualitySelection?.selectedProduct || null,
    selectedLot: null,
    qualityChoices: qualitySelection?.qualityChoices || [],
  });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x: qualitySelection.x, y: qualitySelection.y, button: 'left', clickCount: 1,
    });
  }
  await new Promise(resolve => setTimeout(resolve, 900));

  const openControl = await cdp.evaluate(`
    const normalizeSlug = ${normalizeAssetSlug.toString()};
    const expected = ${JSON.stringify(expectedSlug)};
    const proof = window.__exchangeProductProof;
    if (!proof?.scope?.isConnected || !proof?.image?.isConnected ||
        normalizeSlug(proof.image.currentSrc || proof.image.src || '') !== expected) {
      return { ok:false, reason:'exact selected product proof changed before opening the form' };
    }
    const labels = Array.from(proof.scope.querySelectorAll('button,a,[role="button"],div,span'))
      .filter(element => element.offsetParent !== null && /^sell on the exchange$/i.test(norm(element.innerText)));
    const controls = [...new Set(labels.map(label => label.closest('button,a,[role="button"]') || label))];
    const interactiveControls = controls.filter(candidate =>
      /^(BUTTON|A)$/i.test(candidate.tagName) || candidate.getAttribute('role') === 'button');
    const candidates = interactiveControls.length ? interactiveControls : controls;
    candidates.sort((a, b) => {
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    });
    const control = candidates[0];
    if (!control) return { ok:false, reason:'no exact SELL ON THE EXCHANGE opener in selected product panel' };
    if (candidates.length !== 1) return {
      ok:false,
      reason:'ambiguous SELL ON THE EXCHANGE opener in selected product panel',
      controls:candidates.map(candidate => {
        const candidateRect = candidate.getBoundingClientRect();
        return {
          tag:candidate.tagName,
          role:candidate.getAttribute('role'),
          text:norm(candidate.innerText),
          area:Math.round(candidateRect.width * candidateRect.height),
        };
      }),
    };
    control.scrollIntoView({block:'center'});
    const rect = control.getBoundingClientRect();
    window.__exchangeOpenControl = control;
    window.__exchangeOpenProof = {
      expectedSlug:expected,
      actualSlug:normalizeSlug(proof.image.currentSrc || proof.image.src || ''),
      exactProduct:normalizeSlug(proof.image.currentSrc || proof.image.src || '') === expected,
      controlText:norm(control.innerText),
      unique:candidates.length === 1,
    };
    return { ok:true, x:rect.x + rect.width / 2, y:rect.y + rect.height / 2 };
  `);
  if (!openControl?.ok) return finish({
    ok:false,
    step:'open',
    reason:openControl?.reason || 'exchange form opener missing',
    controls:openControl?.controls || [],
    selectedProduct:qualitySelection.selectedProduct,
    selectedLot:qualitySelection.selectedLot,
    qualityChoices:qualitySelection.qualityChoices,
  });
  for (const type of ['mousePressed', 'mouseReleased']) {
    await cdp.send('Input.dispatchMouseEvent', {
      type, x:openControl.x, y:openControl.y, button:'left', clickCount:1,
    });
  }
  await new Promise(resolve => setTimeout(resolve, 2600));

  // Fill the form and build a fresh review from the live DOM. In armed mode, the validation and
  // final click occur in this same evaluation without an intervening await or browser round trip.
  const result = await cdp.evaluate(`
    const normalizeSlug = ${normalizeAssetSlug.toString()};
    const validateReview = ${validateExchangeUiReview.toString()};
    const validatePostSubmit = ${validateExchangePostSubmit.toString()};
    const arm = ${ARM};
    const expectedSlug = ${JSON.stringify(expectedSlug)};
    const expectedQty = ${requestedQty};
    const expectedPrice = ${JSON.stringify(requestedPrice)};
    const expectedKind = ${expectedKind};
    const expectedReserve = ${JSON.stringify(expectedReserve)};
    const expectedReserveValidUntilMs = ${JSON.stringify(expectedReserveValidUntilMs)};
    const expectedTransportPerUnit = ${JSON.stringify(expectedTransportPerUnit)};
    const expectedLotIndex = ${JSON.stringify(expectedLotIndex)};
    const companyId = ${JSON.stringify(config.companyId)};
    const wantedQty = ${JSON.stringify(String(requestedQty))};
    const wantedPrice = ${JSON.stringify(String(requestedPrice))};
    const visibleInputs = () => all('input').filter(input => input.offsetParent !== null);
    let quantityInput = visibleInputs().find(input => /quantit|amount|units/i.test((input.placeholder || '') + (input.name || '')));
    let priceInput = visibleInputs().find(input => /price/i.test((input.placeholder || '') + (input.name || '')));
    const numericInputs = visibleInputs().filter(input => input.type === 'number');
    if (!quantityInput && numericInputs.length >= 1) quantityInput = numericInputs[0];
    if (!priceInput && numericInputs.length >= 2) priceInput = numericInputs[1];
    if (!quantityInput || !priceInput) return {
      ok:false,
      armed:arm,
      step:'form',
      reason:'quantity or price input was not found',
      qualityChoices:${JSON.stringify(qualitySelection.qualityChoices)},
      dump:{ inputs:visibleInputs().map(input => ({ name:input.name, ph:input.placeholder, val:input.value })) },
    };

    setInput(quantityInput, wantedQty);
    await sleep(300);
    setInput(priceInput, wantedPrice);
    await sleep(900);

    // Fetch authoritative available inventory before the final DOM review. There is no await
    // between the review below and the sole mutation click.
    let inventoryResponse = { status:'ERROR', rows:null };
    try {
      const liveInventory = await api('/api/v3/resources/' + companyId + '/');
      inventoryResponse = {
        status: liveInventory.status,
        rows: liveInventory.status === 200 && Array.isArray(liveInventory.json) ? liveInventory.json : null,
      };
    } catch (_) {}
    const availableForKind = (rows, kind) => Array.isArray(rows)
      ? rows.filter(row => Number(row?.kind) === kind && row?.blocked !== true)
        .reduce((sum, row) => sum + (Number.isFinite(Number(row?.amount)) ? Number(row.amount) : 0), 0)
      : null;
    const inventory = {
      status:inventoryResponse.status,
      kind:expectedKind,
      availableTotal:availableForKind(inventoryResponse.rows, expectedKind),
    };
    const transport = {
      perUnit:expectedTransportPerUnit,
      available:availableForKind(inventoryResponse.rows, 13),
    };

    const exactConfirmButtons = all('button').filter(button => button.offsetParent !== null &&
      button !== window.__exchangeOpenControl && /^sell on the exchange$/i.test(norm(button.innerText)));
    const formButtons = exactConfirmButtons.filter(button => {
      let scope = button;
      while (scope && scope !== document.body) {
        if (scope.contains(quantityInput) && scope.contains(priceInput)) return true;
        scope = scope.parentElement;
      }
      return false;
    });
    const confirm = formButtons.length === 1 ? formButtons[0] : null;
    let formScope = quantityInput;
    while (formScope && formScope !== document.body &&
           !(formScope.contains(priceInput) && (!confirm || formScope.contains(confirm)))) {
      formScope = formScope.parentElement;
    }
    const formBound = formScope && formScope !== document.body && formScope !== document.documentElement &&
      formScope.contains(quantityInput) && formScope.contains(priceInput) && Boolean(confirm) && formScope.contains(confirm);
    const formText = norm((formScope || document.body).innerText);
    const moneyRows = [...formText.matchAll(
      /(Total revenue|Source cost|Transportation cost|Exchange fees(?: \\(4%\\))?|Estimated profit)\\s*(\\(-\\)|-)?\\s*\\$\\s*([\\d,.]+)/gi
    )];
    const moneyAfter = (wantedLabel, signed = false) => {
      const match = moneyRows.find(row => row[1].toLowerCase()
        .replace(/\\s*\\(4%\\)$/i, '') === wantedLabel.toLowerCase());
      if (!match) return null;
      const value = Number(match[3].replace(/,/g, ''));
      if (!Number.isFinite(value)) return null;
      return signed && match[2] ? -value : value;
    };
    const economics = {
      totalRevenue:moneyAfter('Total revenue'),
      sourceCost:moneyAfter('Source cost'),
      transportationCost:moneyAfter('Transportation cost'),
      exchangeFee:moneyAfter('Exchange fees'),
      estimatedProfit:moneyAfter('Estimated profit', true),
      source:'game exchange-sale form',
    };

    const productProof = window.__exchangeProductProof;
    const openerProof = window.__exchangeOpenProof;
    const productImageSlug = productProof?.image?.isConnected
      ? normalizeSlug(productProof.image.currentSrc || productProof.image.src || '') : '';
    const lotProof = window.__exchangeSelectedLotProof;
    const currentLotText = lotProof?.amountElement?.isConnected ? norm(lotProof.amountElement.textContent) : '';
    const currentLotAvailable = /^[\\d,]+$/.test(currentLotText)
      ? Number(currentLotText.replace(/,/g, '')) : null;
    const selectedLot = {
      index:lotProof?.index ?? null,
      available:Number.isFinite(currentLotAvailable) ? currentLotAvailable : (lotProof?.available ?? null),
      inspectedAvailable:lotProof?.available ?? null,
      quality:lotProof?.quality ?? null,
      unitCost:lotProof?.unitCost ?? null,
      rowText:lotProof?.rowText ?? null,
      stillSelected:false,
    };
    const sourceCostTolerance = expectedQty * 0.0005 + 0.011;
    selectedLot.costBound = Number.isFinite(Number(selectedLot.unitCost)) &&
      Number.isFinite(Number(economics.sourceCost)) &&
      Math.abs(Number(economics.sourceCost) - Number(selectedLot.unitCost) * expectedQty) <= sourceCostTolerance;
    // React replaces the hidden inventory row when the modal opens, so DOM node identity cannot
    // survive. The exact index/unit-cost row was clicked above; bind the open form back to that lot
    // through its source-cost total, then independently verify live total inventory and reserve.
    selectedLot.stillSelected = selectedLot.costBound === true &&
      (expectedLotIndex == null || Number(lotProof?.index) === expectedLotIndex) &&
      Number(lotProof?.available) >= expectedQty;
    const exactOpenerBound = openerProof?.expectedSlug === expectedSlug &&
      openerProof?.actualSlug === expectedSlug && openerProof?.exactProduct === true &&
      openerProof?.unique === true && /^sell on the exchange$/i.test(String(openerProof?.controlText || ''));
    const selectedProduct = {
      requestedSlug:expectedSlug,
      actualSlug:productImageSlug,
      exact:Boolean(productProof?.scope?.isConnected) && productImageSlug === expectedSlug,
      scopeConnected:Boolean(productProof?.scope?.isConnected),
      boundToForm:Boolean(formBound) && exactOpenerBound && selectedLot.costBound === true,
      bindingSource:'exact product panel + exact opener + selected-lot source cost',
    };
    const review = {
      expectedSlug,
      expectedQty,
      expectedPrice,
      expectedKind,
      expectedReserve,
      selectedProduct,
      selectedLot,
      inventory,
      transport,
      inputs:{
        quantityRaw:String(quantityInput.value),
        quantity:Number(quantityInput.value),
        priceRaw:String(priceInput.value),
        price:Number(priceInput.value),
      },
      economics,
      confirm:{
        found:Boolean(confirm),
        unique:formButtons.length === 1,
        disabled:confirm ? Boolean(confirm.disabled) : null,
        ariaDisabled:confirm ? String(confirm.getAttribute('aria-disabled') || '').toLowerCase() === 'true' : null,
        pointerDisabled:confirm ? getComputedStyle(confirm).pointerEvents === 'none' : null,
        text:confirm ? norm(confirm.innerText) : null,
        candidates:formButtons.length,
      },
    };
    const validation = validateReview(review);
    const dump = {
      inputs:visibleInputs().map(input => ({ ph:input.placeholder, name:input.name, val:String(input.value).slice(0, 30) })),
      buttons:all('button').filter(button => button.offsetParent !== null)
        .map(button => ({
          t:norm(button.innerText),
          dis:button.disabled,
          ariaDis:String(button.getAttribute('aria-disabled') || '').toLowerCase() === 'true',
          pointerDis:getComputedStyle(button).pointerEvents === 'none',
        })).slice(0, 20),
      text:formText.slice(-700),
    };
    if (!validation.ok) return {
      ok:false,
      armed:arm,
      step:'pre-submit-verification',
      reason:validation.failures.join('; '),
      verification:review,
      validation,
      qualityChoices:${JSON.stringify(qualitySelection.qualityChoices)},
      dump,
    };
    if (!arm) return {
      ok:true,
      armed:false,
      submitted:false,
      verification:review,
      validation,
      confirmFound:review.confirm.text,
      qualityChoices:${JSON.stringify(qualitySelection.qualityChoices)},
      dump,
    };

    if (!Number.isFinite(expectedReserveValidUntilMs) || Date.now() > expectedReserveValidUntilMs) {
      return {
        ok:false,
        armed:true,
        mutationAttempted:false,
        submitted:false,
        outcome:'RESERVE_AUTHORIZATION_EXPIRED',
        reason:'the expiry-safe reserve authorization elapsed before the final click; reinspect before retrying',
        verification:review,
        validation,
        qualityChoices:${JSON.stringify(qualitySelection.qualityChoices)},
      };
    }

    // No await occurs between the successful live-DOM review above and this sole mutation click.
    confirm.click();
    await sleep(3200);
    const formClosed = !quantityInput.isConnected || quantityInput.offsetParent === null ||
      !priceInput.isConnected || priceInput.offsetParent === null ||
      !confirm.isConnected || confirm.offsetParent === null;
    let postInventoryResponse = { status:'ERROR', rows:null };
    try {
      const postInventory = await api('/api/v3/resources/' + companyId + '/');
      postInventoryResponse = {
        status:postInventory.status,
        rows:postInventory.status === 200 && Array.isArray(postInventory.json) ? postInventory.json : null,
      };
    } catch (_) {}
    const postAvailable = availableForKind(postInventoryResponse.rows, expectedKind);
    const postSubmit = validatePostSubmit({
      status:postInventoryResponse.status,
      beforeAvailable:inventory.availableTotal,
      afterAvailable:postAvailable,
      expectedQty,
      formClosed,
    });
    postSubmit.kind = expectedKind;
    if (!postSubmit.ok) return {
      ok:false,
      armed:true,
      mutationAttempted:true,
      submitted:null,
      outcome:formClosed ? 'UNKNOWN_POST_SUBMIT_STATE' : 'UNKNOWN_FORM_STILL_OPEN',
      reason:formClosed
        ? 'confirmation was clicked but the authoritative inventory decrease was not proven; refresh state and reinspect before retrying'
        : 'confirmation was clicked but the form did not close; refresh state and reinspect before retrying',
      preSubmit:review,
      postSubmit,
      validation,
      qualityChoices:${JSON.stringify(qualitySelection.qualityChoices)},
      after:norm(document.body.innerText).slice(-500),
    };
    return {
      ok:true,
      armed:true,
      mutationAttempted:true,
      submitted:review.confirm.text,
      outcome:'INVENTORY_CONFIRMED_AFTER_CLICK',
      preSubmit:review,
      postSubmit,
      validation,
      qualityChoices:${JSON.stringify(qualitySelection.qualityChoices)},
      after:norm(document.body.innerText).slice(-500),
    };
  `);

  result.selectedProduct = qualitySelection.selectedProduct;
  result.selectedLot = qualitySelection.selectedLot;
  result.qualityChoices = result.qualityChoices || qualitySelection.qualityChoices;
  return finish(result);
})().catch(error => finish({ ok:false, err:String(error.message || error) }, 1));
