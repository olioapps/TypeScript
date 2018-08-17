/* @internal */
namespace ts.codefix {
    const fixName = "fixCannotFindModule";
    const fixIdInstallTypesPackage = "installTypesPackage";
    const fixIdGenerateTypes = "generateTypes";

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
                : [createCodeFixAction(fixName, /*changes*/ [], [Diagnostics.Install_0, typesPackageName], fixIdInstallTypesPackage, Diagnostics.Install_all_missing_types_packages, getInstallCommand(sourceFile.fileName, typesPackageName))];
        },
        fixIds: [fixIdInstallTypesPackage, fixIdGenerateTypes],
        getAllCodeActions: context => codeFixAll(context, errorCodes, (_, diag, commands) => {
            const packageName = getPackageName2(diag.file, diag.start);
            switch (context.fixId) {
                case fixIdInstallTypesPackage:
                    const pkg = packageName && getTypesPackageNameToInstall(packageName, context.host, diag.code);
                    if (pkg) {
                        commands.push(getInstallCommand(diag.file.fileName, pkg));
                    }
                    break;
                case fixIdGenerateTypes:
                    throw new Error("TODO"); //!
            }
        }),
    });

    function tryGenerateTypes(context: CodeFixContextBase, packageName: string, importingFileName: string): CodeFixAction | undefined {
        const xxx = doTryGenerateTypes(context, packageName); //name
        if (!xxx) return undefined;
        const { changes, outputFileName } = xxx;
        return changes && createCodeFixAction(fixName, changes, [Diagnostics.Generate_types_for_0, packageName], fixIdGenerateTypes, Diagnostics.Generate_types_for_all_packages_without_types, getGenerateCommand(importingFileName, packageName, outputFileName));
    }

    function doTryGenerateTypes(context: CodeFixContextBase, packageName: string): { readonly changes: FileTextChanges[], readonly outputFileName: string } | undefined {
        const { configFile } = context.program.getCompilerOptions();
        if (!configFile) return undefined;

        //const generatedDtsFile = doDoTryGenerateTypes(packageName, importingFileName, context.host);
        //if (!generatedDtsFile) return undefined;
        let typesDir: string;
        const changes = textChanges.ChangeTracker.with(context, t => {
            typesDir = getOrCreateTypesDirectory(configFile, t);
        });
        return { changes, outputFileName: combinePaths(Debug.assertDefined(typesDir!), packageName + ".d.ts") }
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

    function getInstallCommand(fileName: string, packageName: string): InstallPackageAction {
        return { type: "install package", file: fileName, packageName };
    }

    //!
    function getGenerateCommand(file: string, packageName: string, outputFileName: string): GenerateTypesAction {
        return { type: "generate types", file, packageName, outputFileName };
    }

    //!
    //name
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
