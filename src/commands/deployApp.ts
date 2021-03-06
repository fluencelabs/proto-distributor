/* eslint-disable no-await-in-loop */
import { promises as fs } from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import Joi from 'joi';
import Handlebars from 'handlebars';
import { Context } from 'src/types';
import { createConfig, Distributor } from '../distributor';

const identifierPattern = /^[A-Za-z][A-Za-z_0-9]+$/;

const filePathPatterh = Joi.string();

const node = Joi.string();

const serviceSchema = Joi.object({
	node: node.required(),
	dependencies: Joi.array().items(Joi.string()).default([]),
}).unknown(false);

const moduleSchema = Joi.object({
	file: Joi.string(),
	url: Joi.string().uri(),
	config: Joi.object({
		mapped_dirs: Joi.object() //
			.unknown(true)
			.pattern(filePathPatterh, filePathPatterh)
			.optional(),

		mounted_binaries: Joi.object() //
			.optional(),

		preopened_files: Joi.array() //
			.items(filePathPatterh)
			.optional(),

		mem_pages_count: Joi.number().optional(),

		name: Joi.string().optional(),
	}),
})
	.or('file', 'url')
	.unknown(false);

const scriptStorageSchema = Joi.object({
	file: Joi.string(),
	url: Joi.string().uri(),
	node: node.required(),
	interval: Joi.number().min(3).optional().default(3),
})
	.or('file', 'url')
	.unknown(false);

const scriptsSchema = Joi.object({
	file: Joi.string(),
	url: Joi.string().uri(),
	variables: Joi.object().optional(),
})
	.or('file', 'url')
	.unknown(false);

const appConfigSchema = Joi.object({
	services: Joi.object({}) //
		.unknown(true)
		.pattern(identifierPattern, serviceSchema)
		.required(),

	modules: Joi.object({}) //
		.unknown(true)
		.pattern(identifierPattern, moduleSchema)
		.required(),

	scripts: Joi.object({}) //
		.unknown(true)
		.pattern(identifierPattern, scriptsSchema)
		.required(),

	script_storage: Joi.object({}) //
		.unknown(true)
		.pattern(identifierPattern, scriptStorageSchema)
		.required(),
});

const load = async (fileOrUrl: { file?: string; root?: string; url?: string }): Promise<Buffer> => {
	// loading from file
	if (fileOrUrl.file) {
		let file = fileOrUrl.file;
		if (fileOrUrl.root) {
			file = path.join(fileOrUrl.root, file);
		}

		return fs.readFile(file);
	}

	// loading from url
	const url = fileOrUrl.url!;
	const proto = url.charAt(4).localeCompare('s') ? http : https;

	return new Promise((resolve, reject) => {
		proto.get(url, (response) => {
			if (response.statusCode !== 200) {
				reject(new Error(`Failed to get '${url}' (${response.statusCode})`));
				return;
			}

			const data: any[] = [];

			response
				.on('data', (chunk) => {
					data.push(chunk);
				})
				.on('end', () => {
					// at this point data is an array of Buffers
					// so Buffer.concat() can make us a new Buffer
					// of all of them together
					const buffer = Buffer.concat(data);
					resolve(buffer);
				});
		});
	});
};

const deployApp = async (
	distributor: Distributor,
	context: Context,
	input: string,
	output: string,
	isGeneratedByAqua: boolean,
): Promise<void> => {
	const root = path.dirname(input);

	const inputRaw = await fs.readFile(input, 'utf-8');
	const inputObj = JSON.parse(inputRaw);
	const res = appConfigSchema.validate(inputObj);
	if (res.error) {
		console.log(res.error.annotate());
		return;
	}

	const value = res.value;

	const services = value.services;
	const modules = value.modules;
	const scripts = value.scripts || {};
	const scriptStorageScripts = value.script_storage || {};

	for (const [key, service] of Object.entries<any>(services)) {
		console.log('Loading dependencies for service: ', key);
		service.hashDependencies = [];
		for (const depName of service.dependencies) {
			const module = modules[depName];
			if (!module) {
				throw new Error(`Couldn't find module ${depName} for service, ${key}`);
			}

			console.log('Creating module: ', depName);
			const data = await load({ file: module.file, url: module.url, root: root });
			const base64 = data.toString('base64');
			const config = createConfig({
				name: depName,
				mountedBinaries: module.config.mounted_binaries,
				preopenedFiles: module.config.preopened_files,
				mappedDirs: module.config.mapped_dirs,
			});
			console.log('with config: ', config);

			const hash = await distributor.uploadModuleToNode(service.node, {
				base64,
				config,
			});
			module.hash = hash;
			service.hashDependencies.push(`hash:${hash}`);
		}

		console.log('Creating blueprint for service: ', key);
		console.log('dependencies: ', service.dependencies);
		console.log('hashDependencies: ', service.hashDependencies);
		const bpId = await distributor.uploadBlueprint(service.node, {
			name: key,
			dependencies: service.hashDependencies,
		});
		service.blueprint_id = bpId;

		console.log('Creating service for blueprint %s %s on node %s', key, bpId, service.node);
		const serviceId = await distributor.createService(service.node, bpId);
		service.id = serviceId;
	}

	console.log('Preparing variables...');
	const variables: Record<string, any> = {};
	for (const key of Object.keys(services)) {
		variables[key] = services[key].id;
		variables[`${key}__node`] = services[key].node;
	}
	console.log(variables);

	for (const [key, script] of Object.entries<any>(scripts)) {
		console.log('Running script: ', key);

		const data = await load({ file: script.file, url: script.url, root: root });
		const scriptText = data.toString('utf-8');

		const vars = {
			...variables,
			...script.variables,
		};

		const [_particle, promise] = await distributor.doRunAir(
			isGeneratedByAqua,
			scriptText,
			(args) => {
				const [scriptExecResult] = args;
				console.log('Script execution result: ', scriptExecResult);
			},
			vars,
		);
		await promise;
	}

	for (const [key, script] of Object.entries<any>(scriptStorageScripts)) {
		console.log('Adding script to script_storage: ', key);

		const data = await load({ file: script.file, url: script.url, root: root });
		const text = data.toString('utf-8');
		const readyText = Handlebars.compile(text, { strict: true })(variables);

		console.log(readyText);

		const id = await distributor.addScript(script.node, readyText, script.interval);
		script.id = id;
	}

	await fs.writeFile(output, JSON.stringify(value, undefined, 4), 'utf-8');
	console.log('Application deployed successfully');
};

export default {
	command: 'deploy_app',
	describe: 'Deploy application',
	builder: (yargs: any) => {
		return yargs
			.option('i', {
				alias: 'input',
				demandOption: true,
				describe: 'path to deployment config file',
				type: 'string',
			})
			.option('o', {
				alias: 'output',
				demandOption: true,
				describe: 'path to the file where application config should be written',
				type: 'string',
			})
			.option('generated', {
				demandOption: false,
				default: false,
				describe: 'If enabled, consider AIR scripts to be generated by Aqua Compiler',
				type: 'boolean',
			});
	},
	handler: async (argv: any): Promise<void> => {
		const input: string = argv.i;
		const output: string = argv.o;
		await deployApp(await argv.getDistributor(), argv.context, input, output, argv.generaed);
		process.exit(0);
	},
};
