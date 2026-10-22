import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { composeStore } from '../src/apply/compose.js';
import { runPlan } from '../src/plan/run.js';
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
});
