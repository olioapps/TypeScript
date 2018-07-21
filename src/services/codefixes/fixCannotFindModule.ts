/* @internal */
namespace ts.codefix {
    const fixName = "fixCannotFindModule";
    const fixIdInstallTypesPackage = "installTypesPackage";
    //const fixIdGenerateTypes = "generateTypes";

    const errorCodeCannotFindModule = Diagnostics.Cannot_find_module_0.code;

    const errorCodes = [
        errorCodeCannotFindModule,
        Diagnostics.Could_not_find_a_declaration_file_for_module_0_1_implicitly_has_an_any_type.code,
    ];
    registerCodeFix({
        errorCodes,
        getCodeActions: context => {
            const { host, sourceFile, span: { start } } = context;
            const packageName = getPackageName2(sourceFile, start);
            if (packageName === undefined) return undefined;
            const typesPackageName = getTypesPackageNameToInstall(packageName, host, context.errorCode);
            return typesPackageName === undefined
                ? singleElementArray(tryGenerateTypes(packageName, sourceFile.fileName, context.host))
                : [createCodeFixAction(fixName, /*changes*/ [], [Diagnostics.Install_0, typesPackageName], fixIdInstallTypesPackage, Diagnostics.Install_all_missing_types_packages, getCommand(sourceFile.fileName, typesPackageName))];
        },
        fixIds: [fixIdInstallTypesPackage],
        getAllCodeActions: context => codeFixAll(context, errorCodes, (_, diag, commands) => {
            const packageName = getPackageName2(diag.file, diag.start);
            const pkg = packageName && getTypesPackageNameToInstall(packageName, context.host, diag.code);
            if (pkg) {
                commands.push(getCommand(diag.file.fileName, pkg));
            }
        }),
    });

    function tryGenerateTypes(packageName: string, importingFileName: string, host: LanguageServiceHost): CodeFixAction | undefined {
        const changes = doTryGenerateTypes(packageName, importingFileName, host);
        return changes && createCodeFixActionNoFixId(fixName, changes, [Diagnostics.Generate_types_for_0, packageName]);//, fixIdGenerateTypes)
    }

    function doTryGenerateTypes(packageName: string, importingFileName: string, host: LanguageServiceHost): FileTextChanges[] | undefined {
        const generatedDtsFile = doDoTryGenerateTypes(packageName, importingFileName, host);
        return generatedDtsFile ? [textChanges.newFileTextChange(outName, generatedDtsFile)] : undefined;
    }

    function foo() {
        need to update tsconfig
    }

    function doDoTryGenerateTypes(packageName: string, importingFileName: string, host: LanguageServiceHost): string | undefined {
        const resolved = tryResolveJavaScriptModule(packageName, getDirectoryPath(importingFileName), host as ModuleResolutionHost); // TODO: GH#18217
        return resolved && generateTypesForModule(packageName, resolved);
    }

    function getCommand(fileName: string, packageName: string): InstallPackageAction {
        return { type: "install package", file: fileName, packageName };
    }

    //!
    function getPackageName2(sourceFile: SourceFile, pos: number): string | undefined {
        const moduleName = cast(getTokenAtPosition(sourceFile, pos), isStringLiteral).text;
        const { packageName } = getPackageName(moduleName); //todo: only if it is global!
        return isExternalModuleNameRelative(packageName) ? undefined : packageName;
    }

    function getTypesPackageNameToInstall(packageName: string, host: LanguageServiceHost, diagCode: number): string | undefined {
        return diagCode === errorCodeCannotFindModule
            ? (JsTyping.nodeCoreModules.has(packageName) ? "@types/node" : undefined)
            : (host.isKnownTypesPackageName!(packageName) ? getTypesPackageName(packageName) : undefined); // TODO: GH#18217
    }
}
