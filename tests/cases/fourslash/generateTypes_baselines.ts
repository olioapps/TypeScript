/// <reference path="fourslash.ts" />

////dummy text

verify.generateTypes(
//{
//    value: global,
//    outputBaseline: "global",
//},
{
    value: require("lodash"),
    outputBaseline: "lodash",
},
);
