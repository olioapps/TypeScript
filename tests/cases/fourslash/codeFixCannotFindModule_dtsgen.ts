/// <reference path='fourslash.ts' />

// @Filename: /node_modules/plus/index.js
////module.exports = function plus(x, y) { return x * y; };

// @Filename: /a.ts
////import plus = require("plus");
////plus(2, 2);

// @Filename: /tsconfig.json
////{
////    "compilerOptions": {
////
////    }
////}

TODO: in applyEdits in fourslash.ts it assumes we only update old files

goTo.file("/a.ts");
verify.codeFix({
    description: "Generate types for 'plus'",
    newFileContent: {
        "/tsconfig.json": "tsconfig??",
        "/types/foo": "???",
    },
});

