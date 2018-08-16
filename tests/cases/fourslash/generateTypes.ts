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
    // non-arrow functions have different toString(), so important to test
    value: function(x, y) {
        return x * y;
        function inner() {
            arguments; // Should not affect type inference
        }
    },
    output:
`export = example;
declare function example(x: any, y: any): any;`,
},
{
    value: function(x) { arguments; },
    output:
`export = example;
declare function example(x: any, ...args: any[]): void;`,
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

{
    value: [0],
    output:
`export = example;
declare const example: number[];`,
},
{
    value: [() => 0, () => ""],
    output:
`export = example;
declare const example: Function[];`,
},
{
    value: (() => {
        const a = [];
        a.push(a);
        return a;
    })(),
    output:
`export = example;
declare const example: any[];`,
},
);
