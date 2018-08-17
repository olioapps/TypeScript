/// <reference path="fourslash.ts" />

////dummy text

verify.generateTypes(
{
    value: (() => {
        class C {
            delete() {};
        }
        return C;
    })(),
    output:
`?`,
},
);
