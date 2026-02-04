// @ts-nocheck
import { SysTagParser } from '../src/extras/sys-tags';

describe('SysTagParser (chunk boundary)', () => {
    test('parses SYS_JSON when end tag is split across chunks (event mode)', () => {
        const p = new SysTagParser({ mode: 'event' });

        const r1 = p.consume('<SYS_JSON>{"a":1}</SYS_');
        expect(r1.events).toHaveLength(0);
        expect(r1.output).toBe('');

        const r2 = p.consume('JSON>OK');
        expect(r2.events).toHaveLength(1);
        expect(r2.events[0].type).toBe('sys_json');
        expect(r2.events[0].payload).toEqual({ a: 1 });
        expect(r2.output).toBe('OK');
    });

    test('does not merge two SYS_JSON tags when the first end tag is split (both mode)', () => {
        const p = new SysTagParser({ mode: 'both' });

        const r1 = p.consume('<SYS_JSON>{"x":1}</SYS_');
        expect(r1.events).toHaveLength(0);
        // Incomplete tags are held until they are closed.
        expect(r1.output).toBe('');

        const r2 = p.consume('JSON>\n\n<SYS_JSON>{"y":2}</SYS_JSON>TAIL');
        // Both tags should be parsed as separate events.
        expect(r2.events.map((e) => e.payload)).toEqual([{ x: 1 }, { y: 2 }]);
        // In "both" mode we keep the raw tags in-stream.
        expect(r2.output).toContain('<SYS_JSON>{"x":1}</SYS_JSON>');
        expect(r2.output).toContain('<SYS_JSON>{"y":2}</SYS_JSON>');
        expect(r2.output).toContain('TAIL');
    });
});
