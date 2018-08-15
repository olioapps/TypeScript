/// <reference path="fourslash.ts" />

////dummy text

verify.generateTypes(
//    {
//        source: `module.exports = function plus(x, y) { return x * y; };`,
//        output:
//`export = example;
//declare function example(x: any, y: any): any;`,
//    },
//    {
//        source: `module.exports = 0;`,
//        output:
//`export = example;
//declare const example: number;`,
//    }

{
    source: "module.exports = class {};",
    output:
`export = example;
declare class example {
}`,
},
    //TODO: test class with a constructor with parameters

    //TODO: test for ctr function that acts like a class (has prototype assignments)
{
    source:
`module.exports = F;
function F() {
    this.x = 0;
}`,
    output:
`export = example;
declare class example {
    x: any;
}`,
}

    //TODO: below fails. Same for Date;
    //{
    //    source: `module.exports = Math;`,
    //    output: `?`,
    //}
);
