/// <reference path='fourslash.ts' />

// @Filename: /node_modules/plus/index.js
////module.exports = function plus(x, y) { return x * y; };

// @Filename: /a.ts
////import plus = require("plus");

// @Filename: /tsconfig.json
////{
////    "compilerOptions": {}
////}

goTo.file("/a.ts");
verify.codeFix({
    description: "Generate types for 'plus'",
    newFileContent: {
        "/tsconfig.json":
//TODO: make issue for bad closing brace indent
`{
    "compilerOptions": {
        "typeRoots": ["node_modules", "types"]
}
}`,
    },
    commands: [{
        type: "generate types",
        file: "/a.ts",
        outputFileName: "types/plus.d.ts",
        packageName: "plus",
    }],
});
