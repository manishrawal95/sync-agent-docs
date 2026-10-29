import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeStore } from '../src/apply/compose.js';
import { runPlan } from '../src/plan/run.js';
import type { Store, StoreFact } from '../src/store/types.js';
import type { Attribute } from '../src/types.js';
import { materializeFixture } from './helpers/fixture.js';

const NOW = new Date('2026-10-22T12:00:00.000Z');

describe('composeStore', () => {
  it('a folded view edit wins over a remembered answer for the same attribute, and other answers still land', async () => {
    const fx = await materializeFixture('messy-dev', { commit: true });
    const plan = await runPlan(fx.root, { home: fx.home, reposOnly: false, crontabCommand: 'false', store: join(fx.home, 'truth'), now: NOW });
    for (const i of plan.items) i.answer = i.recommended ?? i.options[0] ?? null;
    const shopPort = plan.items.find((i) => i.entityId === 'project:shop' && i.attribute === 'port');
    if (!shopPort) throw new Error('fixture has no shop port item');
    shopPort.answer = '3300';
    const prev = composeStore(null, plan, [], fx.home);
    const shop = prev.facts.filter((f) => f.entityId === 'project:shop' && f.attribute !== 'command');
    const others = prev.facts.filter((f) => f.entityId !== 'project:shop');
    // The owner changed the port to 3400 in the shop card; the same plan answers come back from decisions.
    const folded = [{ entityId: 'project:shop', commands: false, facts: shop.map((f) => ({ attribute: f.attribute, value: f.attribute === 'port' ? '3400' : f.value })) }];
    const next = composeStore(prev, plan, [], fx.home, folded);
    expect(next.facts.filter((f) => f.entityId === 'project:shop' && f.attribute === 'port').map((f) => f.value)).toEqual(['3400']);
    expect(next.facts.filter((f) => f.entityId !== 'project:shop')).toEqual(others);
  });

  it('a fold keeps a stored value that the view showed with its backtick or line break changed, unless the user changed that row', async () => {
    const fx = await materializeFixture('messy-dev', { commit: true });
    const plan = await runPlan(fx.root, { home: fx.home, reposOnly: false, crontabCommand: 'false', store: join(fx.home, 'truth'), now: NOW });
    const base = composeStore(null, plan, [], fx.home);
    const fact = (attribute: Attribute, value: string): StoreFact => ({ entityId: 'project:shop', attribute, value, sources: [], status: 'verified' });
    const prev = { ...base, facts: [...base.facts.filter((f) => f.entityId !== 'project:shop'), fact('path', 'a`b'), fact('path', 'c\nd'), fact('port', '3300'), fact('command', 'echo `x`')] };
    const rows = (port: string, path = "a'b") => [{ attribute: 'path' as const, value: path }, { attribute: 'path' as const, value: 'c d' }, { attribute: 'port' as const, value: port }];
    const valuesOf = (s: Store, a: Attribute): string[] => s.facts.filter((f) => f.entityId === 'project:shop' && f.attribute === a).map((f) => f.value).sort();

    const unchanged = composeStore(prev, plan, [], fx.home, [{ entityId: 'project:shop', commands: false, facts: rows('3400') }]);
    expect(valuesOf(unchanged, 'path')).toEqual(['a`b', 'c\nd']);
    expect(valuesOf(unchanged, 'port')).toEqual(['3400']);

    const changed = composeStore(prev, plan, [], fx.home, [{ entityId: 'project:shop', commands: false, facts: rows('3300', 'new') }]);
    expect(valuesOf(changed, 'path')).toEqual(['c\nd', 'new']);

    const commands = composeStore(prev, plan, [], fx.home, [{ entityId: 'project:shop', commands: true, facts: [{ attribute: 'command', value: "echo 'x'" }] }]);
    expect(valuesOf(commands, 'command')).toEqual(['echo `x`']);
  });

  it('a row the user typed with a backtick replaces the stored value, even when the view would have shown that value the same way', async () => {
    const fx = await materializeFixture('messy-dev', { commit: true });
    const plan = await runPlan(fx.root, { home: fx.home, reposOnly: false, crontabCommand: 'false', store: join(fx.home, 'truth'), now: NOW });
    const base = composeStore(null, plan, [], fx.home);
    const fact = (attribute: Attribute, value: string): StoreFact => ({ entityId: 'project:shop', attribute, value, sources: [], status: 'verified' });
    const prev = { ...base, facts: [...base.facts.filter((f) => f.entityId !== 'project:shop'), fact('path', "a'b"), fact('command', "echo 'x'")] };
    const next = composeStore(prev, plan, [], fx.home, [
      { entityId: 'project:shop', commands: false, facts: [{ attribute: 'path', value: 'a`b' }] },
      { entityId: 'project:shop', commands: true, facts: [{ attribute: 'command', value: 'echo `x`' }] },
    ]);
    const valuesOf = (a: Attribute): string[] => next.facts.filter((f) => f.entityId === 'project:shop' && f.attribute === a).map((f) => f.value);
    expect(valuesOf('path')).toEqual(['a`b']);
    expect(valuesOf('command')).toEqual(['echo `x`']);
  });

  it('a plan answer lands over an untouched rewritten value and not over a row the user changed', async () => {
    const fx = await materializeFixture('messy-dev', { commit: true });
    const plan = await runPlan(fx.root, { home: fx.home, reposOnly: false, crontabCommand: 'false', store: join(fx.home, 'truth'), now: NOW });
    const shopPort = plan.items.find((i) => i.entityId === 'project:shop' && i.attribute === 'port');
    if (!shopPort) throw new Error('fixture has no shop port item');
    shopPort.answer = '3300';
    const base = composeStore(null, plan, [], fx.home);
    const stored: StoreFact = { entityId: 'project:shop', attribute: 'port', value: 'a`b', sources: [], status: 'verified' };
    const prev = { ...base, facts: [...base.facts.filter((f) => f.entityId !== 'project:shop' || f.attribute !== 'port'), stored] };
    const port = (rows: string): string[] => composeStore(prev, plan, [], fx.home, [{ entityId: 'project:shop', commands: false, facts: [{ attribute: 'port', value: rows }] }])
      .facts.filter((f) => f.entityId === 'project:shop' && f.attribute === 'port').map((f) => f.value);
    expect(port("a'b")).toEqual(['3300']);
    expect(port('zzz')).toEqual(['zzz']);
  });

  it('a rotate-remove whose file went to a manual patch is recorded manual', async () => {
    const fx = await materializeFixture('messy-dev', { commit: true });
    const plan = await runPlan(fx.root, { home: fx.home, reposOnly: false, crontabCommand: 'false', store: join(fx.home, 'truth'), now: NOW });
    const item = plan.items.find((i) => i.tier === 'secret');
    const abs = item?.edits['rotate-remove']?.[0]?.path;
    if (!item || !abs) throw new Error('fixture has no secret item with a rotate-remove edit');
    item.answer = 'rotate-remove';
    expect(composeStore(null, plan, [], fx.home).secrets.map((s) => s.status)).toEqual(['removed']);
    expect(composeStore(null, plan, [], fx.home, [], new Set([abs])).secrets.map((s) => s.status)).toEqual(['manual']);
  });
});
