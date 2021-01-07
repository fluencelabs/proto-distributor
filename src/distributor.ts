import {FluenceClient} from 'fluence/dist/fluenceClient';
import Fluence from 'fluence';
import log from 'loglevel';
import promiseRetry from 'promise-retry';
import {Node} from './environments';
import {build, genUUID} from "fluence/dist/particle";
import {registerService} from "fluence/dist/globalState";
import {ServiceOne} from "fluence/dist/service";
import {promises as fs} from "fs";
import {peerIdToSeed, seedToPeerId} from "fluence/dist/seed";

export const TTL = 20000;

type ModuleConfig = {
	name: string;
	logger_enabled: boolean;
	mounted_binaries: any | undefined;
	wasi: {
		preopened_files: string[];
		mapped_dirs: any | undefined;
	};
	mem_pages_count: number;
};

type Module = {
	base64: string;
	config: ModuleConfig;
};

export async function loadModule(path: string): Promise<string> {
	const data = await fs.readFile(path);
	return data.toString('base64');
}

export async function getModule(name: string, path: string): Promise<Module> {
	return { base64: await loadModule(path), config: config({ name }) }
}

type Blueprint = {
	uuid: string;
	name: string;
	dependencies: string[];
};

type ConfigArgs = {
	name: string;
	mountedBinaries?: any;
	preopenedFiles?: string[];
	mappedDirs?: any;
};

function config(args: ConfigArgs): ModuleConfig {
	return {
		name: args.name,
		mem_pages_count: 100,
		logger_enabled: true,
		mounted_binaries: args.mountedBinaries,
		wasi: {
			preopened_files: args.preopenedFiles || [],
			mapped_dirs: args.mappedDirs,
		},
	};
}

export class Distributor {
	blueprints: Blueprint[];

	nodes: Node[];

	modules: Module[];

	// If innerClient is set, it will be used for all requests. Otherwise, a new client will be generated on each request.
	innerClient?: FluenceClient;

	constructor(nodes: Node[], optionalClient?: FluenceClient) {
		this.nodes = nodes;
		this.innerClient = optionalClient;

		this.blueprints = [
			{
				name: 'SQLite 3',
				uuid: '623c6d14-2204-43c4-84d5-a237bcd19874',
				dependencies: ['sqlite3'],
			},
			{
				name: 'User List',
				uuid: '1cc9f08d-eaf2-4d27-a273-a52cb294a055',
				dependencies: ['sqlite3', 'userlist'],
			},
			{
				name: 'Message History',
				uuid: 'bbe13303-48c9-407f-ac74-88f26dc4bfa7',
				dependencies: ['sqlite3', 'history'],
			},
			{
				name: 'URL Downloader',
				uuid: 'f247e046-7d09-497d-8330-9a41d6c23756',
				dependencies: ['local_storage', 'curl_adapter', 'facade_url_downloader'],
			},
			{
				name: 'Redis',
				uuid: 'b3a22bb4-4ba9-4517-90b1-45cc97f7a610',
				dependencies: ['redis'],
			},
		];

		this.modules = [];
	}

	async load_modules() {
		this.modules = [
			{
				base64: await loadModule('./src/artifacts/url-downloader/curl.wasm'),
				config: config({ name: 'curl_adapter', mountedBinaries: { curl: '/usr/bin/curl' }, preopenedFiles: ['/tmp'] }),
			},
			{
				base64: await loadModule('./src/artifacts/url-downloader/local_storage.wasm'),
				config: config({ name: 'local_storage', preopenedFiles: ['/tmp'], mappedDirs: { sites: '/tmp' } }),
			},
			{
				base64: await loadModule('./src/artifacts/url-downloader/facade.wasm'),
				config: config({ name: 'facade_url_downloader' }),
			},
			{ base64: await loadModule('./src/artifacts/sqlite3.wasm'), config: config({ name: 'sqlite3' }) },
			{ base64: await loadModule('./src/artifacts/user-list.wasm'), config: config({ name: 'userlist' }) },
			{ base64: await loadModule('./src/artifacts/history.wasm'), config: config({ name: 'history' }) },
			{ base64: await loadModule('./src/artifacts/redis.wasm'), config: config({ name: 'redis' }) },
		];
	}

	async makeClient(node: Node, seed?: string): Promise<FluenceClient> {
		let peerId = undefined;
		if (seed) {
			peerId = await seedToPeerId(seed)
		}
		if (typeof this.innerClient !== 'undefined') {
			return this.innerClient;
		}
		return Fluence.connect(node.multiaddr, peerId);
	}

	async uploadModule(node: Node, module: Module) {
		const client = await this.makeClient(node);
		let seed = await peerIdToSeed(client.selfPeerId)
		console.log("seed: " + seed)
		log.warn(
			`uploading module ${module.config.name} to node ${
				node.peerId
			} via client ${client.selfPeerId.toB58String()}`,
		);

		await client.addModule(module.config.name, module.base64, module.config, node.peerId, TTL);
		console.log("module uploaded successfully")
	}

	async uploadBlueprint(node: Node, bp: Blueprint): Promise<Blueprint> {
		const client = await this.makeClient(node);
		log.warn(`uploading blueprint ${bp.name} to node ${node.peerId} via client ${client.selfPeerId.toB58String()}`);

		const blueprintId = await client.addBlueprint(bp.name, bp.dependencies, bp.uuid, node.peerId, TTL);
		if (blueprintId !== bp.uuid) {
			log.error(
				`NON-CONSTANT BLUEPRINT ID: Expected blueprint id to be predefined as ${bp.uuid}, but it was generated by node as ${blueprintId}`,
			);
			return { ...bp, uuid: blueprintId };
		}

		return bp;
	}

	async createService(node: Node, bp: Blueprint): Promise<string> {
		const client = await this.makeClient(node);
		log.warn(`creating service ${bp.name}@${bp.uuid}`);
		let serviceId = await client.createService(bp.uuid, node.peerId, TTL);
		log.warn(
			`service created ${serviceId} as instance of ${bp.name}@${
				bp.uuid
			}`
		);
		return serviceId
	}

	async runAir(node: Node, air: string, data: Map<string, any>, seed?: string): Promise<string> {


		const client = await this.makeClient(node, seed);
		let returnService = genUUID()

		data.set("returnService", returnService);
		data.set("relay", node.peerId);

		let particle = await build(client.selfPeerId, air, data);
		let service = new ServiceOne(returnService, (fnName, args, tetraplets) => {
			console.log("===================")
			console.log(fnName)
			console.log(args)
			console.log(tetraplets)
			console.log("===================")
			return {}
		})
		registerService(service)
		let particleId = await client.sendParticle(particle)
		log.warn(`Particle id: ${particleId}. Waiting for results... Press Ctrl+C to stop the script.`)
		return particleId
	}

	async uploadAllModules(node: Node) {
		for await (const module of this.modules) {
			await this.uploadModule(node, module);
		}
	}

	async uploadAllModulesToAllNodes() {
		for await (const node of this.nodes) {
			await this.uploadAllModules(node);
		}
	}

	async uploadAllBlueprints(node: Node) {
		for await (const bp of this.blueprints) {
			await this.uploadBlueprint(node, bp);
		}
	}

	async uploadAllBlueprintsToAllNodes() {
		for await (const node of this.nodes) {
			await this.uploadAllBlueprints(node);
		}
	}

	async distributeServices(relay: Node, distribution: Map<string, number[]>) {
		// this.innerClient = await this.makeClient(relay);

		// Cache information about uploaded modules & blueprints to avoid uploading them several times
		const uploadedModules = new Set<[Node, string]>();
		const uploadedBlueprints = new Set<[Node, string]>();

		async function uploadM(d: Distributor, node: Node, module: Module) {
			const already = uploadedModules.has([node, module.config.name]);
			if (!already) {
				await promiseRetry({ retries: 3 }, () => d.uploadModule(node, module));
			}
			uploadedModules.add([node, module.config.name]);
		}

		async function uploadB(d: Distributor, node: Node, bp: Blueprint): Promise<Blueprint> {
			const already = uploadedBlueprints.has([node, bp.name]);
			if (!already) {
				const blueprint = await promiseRetry({ retries: 3 }, () => d.uploadBlueprint(node, bp));
				uploadedBlueprints.add([node, bp.name]);
				return blueprint;
			}

			return bp;
		}

		for await (const [name, nodes] of distribution.entries()) {
			const blueprint = this.blueprints.find((bp) => bp.name === name);
			if (!blueprint) {
				throw new Error(`can't find blueprint ${name}`);
			}

			const modules: [string, Module | undefined][] = blueprint.dependencies.map((moduleName) => [
				moduleName,
				this.modules.find((m) => m.config.name === moduleName),
			]);

			for await (const idx of nodes) {
				const node = this.nodes[idx];
				for await (const [nameM, module] of modules) {
					if (module) {
						await uploadM(this, node, module);
					} else {
						throw new Error(`can't find dependency ${nameM} for bluprint ${blueprint.name}`);
					}
				}
				const bp = await uploadB(this, node, blueprint);
				await this.createService(node, bp);
			}
		}
	}
}
