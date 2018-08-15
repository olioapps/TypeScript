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
                ? singleElementArray(tryGenerateTypes(context, packageName, sourceFile.fileName))
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

    function tryGenerateTypes(context: CodeFixContextBase, packageName: string, importingFileName: string): CodeFixAction | undefined {
        const changes = doTryGenerateTypes(context, packageName, importingFileName);
        return changes && createCodeFixActionNoFixId(fixName, changes, [Diagnostics.Generate_types_for_0, packageName]);//, fixIdGenerateTypes)
    }

    function doTryGenerateTypes(context: CodeFixContextBase, packageName: string, importingFileName: string): FileTextChanges[] | undefined {
        const { configFile } = context.program.getCompilerOptions();
        if (!configFile) return undefined;

        const generatedDtsFile = doDoTryGenerateTypes(packageName, importingFileName, context.host);
        if (!generatedDtsFile) return undefined;

        return textChanges.ChangeTracker.with(context, t => {
            const typesDir = getOrCreateTypesDirectory(configFile, t);
            t.createNewFile(/*oldFile*/ undefined, combinePaths(typesDir, packageName + ".d.ts"), generatedDtsFile); //neater
        });
    }

    //If no types directory exists yet, adds it to tsconfig.json
    function getOrCreateTypesDirectory(tsconfig: TsConfigSourceFile, changes: textChanges.ChangeTracker): string {
        const defaultName = "types";

        const tsconfigObjectLiteral = getTsConfigObjectLiteralExpression(tsconfig);
        if (!tsconfigObjectLiteral) {
            return defaultName;
        }

        const newTypeRootsProperty = createPropertyAssignment(createStringLiteral("typeRoots"), createArrayLiteral([createStringLiteral("node_modules"), createStringLiteral(defaultName)]));

        const compilerOptionsProperty = findProperty(tsconfigObjectLiteral, "compilerOptions");
        if (!compilerOptionsProperty) {
            //test
            changes.insertNodeAtObjectStart(tsconfig, tsconfigObjectLiteral, createPropertyAssignment(createStringLiteral("compilerOptions"), createObjectLiteral([newTypeRootsProperty])));
            return defaultName;
        }

        const compilerOptions = compilerOptionsProperty.initializer;
        if (!isObjectLiteralExpression(compilerOptions)) return defaultName;

        const typeRoots = findProperty(compilerOptions, "typeRoots");
        if (!typeRoots) {
            changes.insertNodeAtObjectStart(tsconfig, compilerOptions, newTypeRootsProperty);
            return defaultName;
        }

        const typeRootsArray = typeRoots.initializer;
        if (!isArrayLiteralExpression(typeRootsArray) || typeRootsArray.elements.length === 0) return defaultName;
        //If there's a non-`node_modules` entry there, put types there.
        //todo: path normalization
        const firstTypesDirectory = find(typeRootsArray.elements, (r): r is StringLiteral => isStringLiteral(r) && r.text !== "node_modules");
        if (firstTypesDirectory) {
            return firstTypesDirectory.text;
        }
        else {
            changes.insertNodeAfter(tsconfig, last(typeRootsArray.elements), createStringLiteral(defaultName));
            return defaultName;
        }
    }

    function findProperty(o: ObjectLiteralExpression, name: string): PropertyAssignment | undefined {
        return find(o.properties, (p): p is PropertyAssignment => isPropertyAssignment(p) && !!p.name && isStringLiteral(p.name) && p.name.text === name)
    }

    function doDoTryGenerateTypes(packageName: string, importingFileName: string, host: LanguageServiceHost): ReadonlyArray<Statement> | undefined {
        const resolved = tryResolveJavaScriptModule(packageName, getDirectoryPath(importingFileName), host as ModuleResolutionHost); // TODO: GH#18217
        const x = resolved === undefined ? undefined : host.tryRequire && host.tryRequire(resolved);
        return x === undefined ? undefined : generateTypesForModule(packageName, x);
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
