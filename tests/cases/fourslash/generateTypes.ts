/// <reference path="fourslash.ts" />

////dummy text

verify.generateTypes(
{
    value: 0,
    output:
`export = example;
declare const example: number;`,
},
{
    value: (x, y) => x + y,
    output:
`export = example;
declare function example(x: any, y: any): void;`,
},
{
    value: function(x, y) { return x * y; }, // non-arrow functions have different toString(), so important to test
    output:
`export = example;
declare function example(x: any, y: any): any;`,
},

{
    value: class {},
    output:
`export = example;
declare class example {
}`,
},

{
    value: class {
        constructor(x) {
            (this as any).x = x;
        }
    },
    output:
`export = example;
declare class example {
    constructor(x: any);
    x: any;
}`,
},

{
    value: class {
        _privateField = 0;
        field = 0;
        fnField = () => 0;

        _privateMethod() {}
        method(_p) {}

        static _privateStatic() {}
        static staticMethod(_s: any) {}

        static _privateStaticField = 0;
        static staticField = 0;
    },
    output:
`export = example;
declare class example {
    static staticField: number;
    static staticMethod(_s: any): void;
    field: any;
    fnField: any;
    method(_p: any): void;
}`,
},

    //TODO: test for ctr function that acts like a class (has prototype assignments)
{
    value: function F() { this.x = 0; },
    output:
`export = example;
declare class example {
    x: any;
}`,
},

{
    value: (() => {
        const o = { a: 0, b: "", self: null };
        o.self = o;
        return o;
    })(),
    output:
`export = example;
declare const example: {
    a: number;
    b: string;
    self: any;
};`,
},

{
    value: (() => {
        const o = {
            //TODO: test funny name
            default: 0,
            a: 0,
            b: "",
            self: null,
            fn: x => x,
            ns1: { x: 0, default: 0 },
            ns2: { fn: x => x, default: 0 },
        };
        o.self = o;
        return o;
    })(),
    output:
`export const a: number;
export const b: string;
export default _default;
export const _default: number;
export function fn(x: any): void;
export const ns1: {
    default: number;
    x: number;
};
export namespace ns2 {
    function fn(x: any): void;
}
export const self: any;`,
},


{
    value: ({ default() {} }),
    output:
`export default function _default(): void;`,
},

{
    value: ({ default: class {} }),
    output:
`export default class _default {
}`,
},

{
    value: new Date(),
    output:
`export = example;
declare const example: Date;`,
},
);
