import { v4 as uuidv4 } from 'uuid';
import { Context } from '../types';
import { Distributor, getModule } from '../distributor';

export default {
	command: 'new_service',
	describe: 'Create service from a list of modules',
	builder: (yargs) => {
		return yargs
			.option('ms', {
				alias: 'modules',
				demandOption: true,
				describe: 'array of path:config pairs; meaning <path to wasm module>:<path to config>',
				type: 'array',
			})
			.coerce('modules', (arg: string[]) => {
				return arg.map((s) => {
					const [wasmPath, configPath] = s.split(':');
					return { wasmPath, configPath };
				});
			})
			.option('n', {
				alias: 'name',
				demandOption: true,
				describe: 'name of the service; will be set in the blueprint',
				type: 'string',
			});
	},
	handler: async (argv): Promise<void> => {
		const context = argv.context as Context;
		const distributor: Distributor = await argv.getDistributor();

		const node = context.relay;
		const blueprintName = argv.name as string;
		const moduleConfigs = argv.modules as Array<{ wasmPath: string; configPath?: string }>;

		// upload modules
		const modules = await Promise.all(moduleConfigs.map((m) => getModule(m.wasmPath, undefined, m.configPath)));
		const promises = modules.map((module) => {
			return distributor.uploadModuleToNode(node.peerId, module);
		});
		await Promise.all(promises);

		// create blueprints
		const dependencies = modules.map((m) => m.config.name);
		const blueprintId = await distributor.uploadBlueprint(node.peerId, {
			name: blueprintName,
			id: uuidv4(),
			dependencies: dependencies,
		});

		// create service
		const serviceId = await distributor.createService(node.peerId, blueprintId);
		console.log(`service id: ${serviceId}`);
		console.log('service created successfully');
		process.exit(0);
	},
};
