const r = await api('/api/v2/companies/me/buildings/');
return { status: r.status, isArr: Array.isArray(r.json), n: r.json && r.json.length,
         sample: JSON.stringify(r.json).slice(0, 1200) };
