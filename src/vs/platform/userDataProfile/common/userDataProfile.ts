/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { hash } from '../../../base/common/hash.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { basename, joinPath } from '../../../base/common/resources.js';
import { URI, UriDto } from '../../../base/common/uri.js';
import { localize } from '../../../nls.js';
import { IEnvironmentService } from '../../environment/common/environment.js';
import { FileOperationResult, IFileService, toFileOperationResult } from '../../files/common/files.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { ILogService } from '../../log/common/log.js';
import { IAnyWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier } from '../../workspace/common/workspace.js';
import { ResourceMap } from '../../../base/common/map.js';
import { IStringDictionary } from '../../../base/common/collections.js';
import { IUriIdentityService } from '../../uriIdentity/common/uriIdentity.js';
import { Promises } from '../../../base/common/async.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { escapeRegExpCharacters } from '../../../base/common/strings.js';
import { isString } from '../../../base/common/types.js';

export const enum ProfileResourceType {
	Settings = 'settings',
	Keybindings = 'keybindings',
	ModelSelection = 'modelSelection',
	Snippets = 'snippets',
	Tasks = 'tasks',
	Extensions = 'extensions',
	GlobalState = 'globalState',
}

/**
 * Flags to indicate whether to use the default profile or not.
 */
export type UseDefaultProfileFlags = { [key in ProfileResourceType]?: boolean };
export type ProfileResourceTypeFlags = UseDefaultProfileFlags;

export interface IUserDataProfile {
	readonly id: string;
	readonly isDefault: boolean;
	readonly name: string;
	readonly shortName?: string;
	readonly icon?: string;
	readonly location: URI;
	readonly globalStorageHome: URI;
	readonly settingsResource: URI;
	readonly keybindingsResource: URI;
	readonly modelSelectionResource: URI;
	readonly tasksResource: URI;
	readonly snippetsHome: URI;
	readonly extensionsResource: URI;
	readonly cacheHome: URI;
	readonly useDefaultFlags?: UseDefaultProfileFlags;
	readonly isTransient?: boolean;
}

export function isUserDataProfile(thing: unknown): thing is IUserDataProfile {
	const candidate = thing as IUserDataProfile | undefined;

	return !!(candidate && typeof candidate === 'object'
		&& typeof candidate.id === 'string'
		&& typeof candidate.isDefault === 'boolean'
		&& typeof candidate.name === 'string'
		&& URI.isUri(candidate.location)
		&& URI.isUri(candidate.globalStorageHome)
		&& URI.isUri(candidate.settingsResource)
		&& URI.isUri(candidate.keybindingsResource)
		&& URI.isUri(candidate.modelSelectionResource)
		&& URI.isUri(candidate.tasksResource)
		&& URI.isUri(candidate.snippetsHome)
		&& URI.isUri(candidate.extensionsResource)
	);
}

export type DidChangeProfilesEvent = { readonly added: readonly IUserDataProfile[]; readonly removed: readonly IUserDataProfile[]; readonly updated: readonly IUserDataProfile[]; readonly all: readonly IUserDataProfile[] };

export type WillCreateProfileEvent = {
	profile: IUserDataProfile;
	join(promise: Promise<void>): void;
};

export type WillRemoveProfileEvent = {
	profile: IUserDataProfile;
	join(promise: Promise<void>): void;
};

export interface IUserDataProfileOptions {
	readonly shortName?: string;
	readonly icon?: string;
	readonly useDefaultFlags?: UseDefaultProfileFlags;
	readonly transient?: boolean;
}

export interface IUserDataProfileUpdateOptions extends Omit<IUserDataProfileOptions, 'icon'> {
	readonly name?: string;
	readonly icon?: string | null;
}

export const IUserDataProfilesService = createDecorator<IUserDataProfilesService>('IUserDataProfilesService');
export interface IUserDataProfilesService {
	readonly _serviceBrand: undefined;

	readonly profilesHome: URI;
	readonly defaultProfile: IUserDataProfile;

	readonly onDidChangeProfiles: Event<DidChangeProfilesEvent>;
	readonly profiles: readonly IUserDataProfile[];

	readonly onDidResetWorkspaces: Event<void>;

	isEnabled(): boolean;
	createNamedProfile(name: string, options?: IUserDataProfileOptions, workspaceIdentifier?: IAnyWorkspaceIdentifier): Promise<IUserDataProfile>;
	createTransientProfile(workspaceIdentifier?: IAnyWorkspaceIdentifier): Promise<IUserDataProfile>;
	createProfile(id: string, name: string, options?: IUserDataProfileOptions, workspaceIdentifier?: IAnyWorkspaceIdentifier): Promise<IUserDataProfile>;
	updateProfile(profile: IUserDataProfile, options?: IUserDataProfileUpdateOptions,): Promise<IUserDataProfile>;
	removeProfile(profile: IUserDataProfile): Promise<void>;

	setProfileForWorkspace(workspaceIdentifier: IAnyWorkspaceIdentifier, profile: IUserDataProfile): Promise<void>;
	resetWorkspaces(): Promise<void>;

	cleanUp(): Promise<void>;
	cleanUpTransientProfiles(): Promise<void>;
}

export function reviveProfile(profile: UriDto<IUserDataProfile>, scheme: string): IUserDataProfile {
	return {
		id: profile.id,
		isDefault: profile.isDefault,
		name: profile.name,
		shortName: profile.shortName,
		icon: profile.icon,
		location: URI.revive(profile.location).with({ scheme }),
		globalStorageHome: URI.revive(profile.globalStorageHome).with({ scheme }),
		settingsResource: URI.revive(profile.settingsResource).with({ scheme }),
		keybindingsResource: URI.revive(profile.keybindingsResource).with({ scheme }),
		modelSelectionResource: URI.revive(profile.modelSelectionResource).with({ scheme }),
		tasksResource: URI.revive(profile.tasksResource).with({ scheme }),
		snippetsHome: URI.revive(profile.snippetsHome).with({ scheme }),
		extensionsResource: URI.revive(profile.extensionsResource).with({ scheme }),
		cacheHome: URI.revive(profile.cacheHome).with({ scheme }),
		useDefaultFlags: profile.useDefaultFlags,
		isTransient: profile.isTransient,
	};
}

export function toUserDataProfile(id: string, name: string, location: URI, profilesCacheHome: URI, options?: IUserDataProfileOptions, defaultProfile?: IUserDataProfile): IUserDataProfile {
	return {
		id,
		name,
		location,
		isDefault: false,
		shortName: options?.shortName,
		icon: options?.icon,
		globalStorageHome: defaultProfile && options?.useDefaultFlags?.globalState ? defaultProfile.globalStorageHome : joinPath(location, 'globalStorage'),
		settingsResource: defaultProfile && options?.useDefaultFlags?.settings ? defaultProfile.settingsResource : joinPath(location, 'settings.json'),
		keybindingsResource: defaultProfile && options?.useDefaultFlags?.keybindings ? defaultProfile.keybindingsResource : joinPath(location, 'keybindings.json'),
		modelSelectionResource: defaultProfile && options?.useDefaultFlags?.modelSelection ? defaultProfile.modelSelectionResource : joinPath(location, 'modelSelection.json'),
		tasksResource: defaultProfile && options?.useDefaultFlags?.tasks ? defaultProfile.tasksResource : joinPath(location, 'tasks.json'),
		snippetsHome: defaultProfile && options?.useDefaultFlags?.snippets ? defaultProfile.snippetsHome : joinPath(location, 'snippets'),
		extensionsResource: defaultProfile && options?.useDefaultFlags?.extensions ? defaultProfile.extensionsResource : joinPath(location, 'extensions.json'),
		cacheHome: joinPath(profilesCacheHome, id),
		useDefaultFlags: options?.useDefaultFlags,
		isTransient: options?.transient
	};
}

export type UserDataProfilesObject = {
	profiles: IUserDataProfile[];
	workspaces: ResourceMap<IUserDataProfile>;
	emptyWindows: Map<string, IUserDataProfile>;
};

type TransientUserDataProfilesObject = UserDataProfilesObject & {
	folders: ResourceMap<IUserDataProfile>;
};

export type StoredUserDataProfile = {
	name: string;
	location: URI;
	shortName?: string;
	icon?: string;
	useDefaultFlags?: UseDefaultProfileFlags;
};

export type StoredProfileAssociations = {
	workspaces?: IStringDictionary<string>;
	emptyWindows?: IStringDictionary<string>;
};

export class UserDataProfilesService extends Disposable implements IUserDataProfilesService {

	protected static readonly PROFILES_KEY = 'userDataProfiles';
	protected static readonly PROFILE_ASSOCIATIONS_KEY = 'profileAssociations';

	readonly _serviceBrand: undefined;

	protected enabled: boolean = true;
	readonly profilesHome: URI;
	private readonly profilesCacheHome: URI;

	get defaultProfile(): IUserDataProfile { return this.profiles[0]; }
	get profiles(): IUserDataProfile[] { return [...this.profilesObject.profiles, ...this.transientProfilesObject.profiles]; }

	protected readonly _onDidChangeProfiles = this._register(new Emitter<DidChangeProfilesEvent>());
	readonly onDidChangeProfiles = this._onDidChangeProfiles.event;

	protected readonly _onWillCreateProfile = this._register(new Emitter<WillCreateProfileEvent>());
	readonly onWillCreateProfile = this._onWillCreateProfile.event;

	protected readonly _onWillRemoveProfile = this._register(new Emitter<WillRemoveProfileEvent>());
	readonly onWillRemoveProfile = this._onWillRemoveProfile.event;

	private readonly _onDidResetWorkspaces = this._register(new Emitter<void>());
	readonly onDidResetWorkspaces = this._onDidResetWorkspaces.event;

	private profileCreationPromises = new Map<string, Promise<IUserDataProfile>>();

	protected readonly transientProfilesObject: TransientUserDataProfilesObject = {
		profiles: [],
		folders: new ResourceMap(),
		workspaces: new ResourceMap(),
		emptyWindows: new Map()
	};

	constructor(
		@IEnvironmentService protected readonly environmentService: IEnvironmentService,
		@IFileService protected readonly fileService: IFileService,
		@IUriIdentityService protected readonly uriIdentityService: IUriIdentityService,
		@ILogService protected readonly logService: ILogService
	) {
		super();
		this.profilesHome = joinPath(this.environmentService.userRoamingDataHome, 'profiles');
		this.profilesCacheHome = joinPath(this.environmentService.cacheHome, 'CachedProfilesData');
	}

	init(): void {
		this._profilesObject = undefined;
	}

	setEnablement(enabled: boolean): void {
		if (this.enabled !== enabled) {
			this._profilesObject = undefined;
			this.enabled = enabled;
		}
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	protected _profilesObject: UserDataProfilesObject | undefined;
	protected get profilesObject(): UserDataProfilesObject {
		if (!this._profilesObject) {
			const defaultProfile = this.createDefaultProfile();
			const profiles = [defaultProfile];
			if (this.enabled) {
				try {
					for (const storedProfile of this.getStoredProfiles()) {
						if (!storedProfile.name || !isString(storedProfile.name) || !storedProfile.location) {
							this.logService.warn('Skipping the invalid stored profile', storedProfile.location || storedProfile.name);
							continue;
						}
						profiles.push(toUserDataProfile(basename(storedProfile.location), storedProfile.name, storedProfile.location, this.profilesCacheHome, { shortName: storedProfile.shortName, icon: storedProfile.icon, useDefaultFlags: storedProfile.useDefaultFlags }, defaultProfile));
					}
				} catch (error) {
					this.logService.error(error);
				}
			}
			const workspaces = new ResourceMap<IUserDataProfile>();
			const emptyWindows = new Map<string, IUserDataProfile>();
			if (profiles.length) {
				try {
					const profileAssociaitions = this.getStoredProfileAssociations();
					if (profileAssociaitions.workspaces) {
						for (const [workspacePath, profileId] of Object.entries(profileAssociaitions.workspaces)) {
							const workspace = URI.parse(workspacePath);
							const profile = profiles.find(p => p.id === profileId);
							if (profile) {
								workspaces.set(workspace, profile);
							}
						}
					}
					if (profileAssociaitions.emptyWindows) {
						for (const [windowId, profileId] of Object.entries(profileAssociaitions.emptyWindows)) {
							const profile = profiles.find(p => p.id === profileId);
							if (profile) {
								emptyWindows.set(windowId, profile);
							}
						}
					}
				} catch (error) {
					this.logService.error(error);
				}
			}
			this._profilesObject = { profiles, workspaces, emptyWindows };
		}
		return this._profilesObject;
	}

	private createDefaultProfile() {
		const defaultProfile = toUserDataProfile('__default__profile__', localize('defaultProfile', "Default"), this.environmentService.userRoamingDataHome, this.profilesCacheHome);
		return { ...defaultProfile, extensionsResource: this.getDefaultProfileExtensionsLocation() ?? defaultProfile.extensionsResource, isDefault: true };
	}

	async createTransientProfile(workspaceIdentifier?: IAnyWorkspaceIdentifier): Promise<IUserDataProfile> {
		const namePrefix = `Temp`;
		const nameRegEx = new RegExp(`${escapeRegExpCharacters(namePrefix)}\\s(\\d+)`);
		let nameIndex = 0;
		for (const profile of this.profiles) {
			const matches = nameRegEx.exec(profile.name);
			const index = matches ? parseInt(matches[1]) : 0;
			nameIndex = index > nameIndex ? index : nameIndex;
		}
		const name = `${namePrefix} ${nameIndex + 1}`;
		return this.createProfile(hash(generateUuid()).toString(16), name, { transient: true }, workspaceIdentifier);
	}

	async createNamedProfile(name: string, options?: IUserDataProfileOptions, workspaceIdentifier?: IAnyWorkspaceIdentifier): Promise<IUserDataProfile> {
		return this.createProfile(hash(generateUuid()).toString(16), name, options, workspaceIdentifier);
	}

	async createProfile(id: string, name: string, options?: IUserDataProfileOptions, workspaceIdentifier?: IAnyWorkspaceIdentifier): Promise<IUserDataProfile> {
		if (!this.enabled) {
			throw new Error(`Profiles are disabled in the current environment.`);
		}

		const profile = await this.doCreateProfile(id, name, options);

		if (workspaceIdentifier) {
			await this.setProfileForWorkspace(workspaceIdentifier, profile);
		}

		return profile;
	}

	private async doCreateProfile(id: string, name: string, options?: IUserDataProfileOptions): Promise<IUserDataProfile> {
		if (!isString(name) || !name) {
			throw new Error('Name of the profile is mandatory and must be of type `string`');
		}
		let profileCreationPromise = this.profileCreationPromises.get(name);
		if (!profileCreationPromise) {
			profileCreationPromise = (async () => {
				try {
					const existing = this.profiles.find(p => p.name === name || p.id === id);
					if (existing) {
						throw new Error(`Profile with ${name} name already exists`);
					}

					const profile = toUserDataProfile(id, name, joinPath(this.profilesHome, id), this.profilesCacheHome, options, this.defaultProfile);
					await this.fileService.createFolder(profile.location);

					const joiners: Promise<void>[] = [];
					this._onWillCreateProfile.fire({
						profile,
						join(promise) {
							joiners.push(promise);
						}
					});
					await Promises.settled(joiners);

					this.updateProfiles([profile], [], []);
					return profile;
				} finally {
					this.profileCreationPromises.delete(name);
				}
			})();
			this.profileCreationPromises.set(name, profileCreationPromise);
		}
		return profileCreationPromise;
	}

	async updateProfile(profileToUpdate: IUserDataProfile, options: IUserDataProfileUpdateOptions): Promise<IUserDataProfile> {
		if (!this.enabled) {
			throw new Error(`Profiles are disabled in the current environment.`);
		}

		let profile = this.profiles.find(p => p.id === profileToUpdate.id);
		if (!profile) {
			throw new Error(`Profile '${profileToUpdate.name}' does not exist`);
		}

		profile = toUserDataProfile(profile.id, options.name ?? profile.name, profile.location, this.profilesCacheHome, {
			shortName: options.shortName ?? profile.shortName,
			icon: options.icon === null ? undefined : options.icon ?? profile.icon,
			transient: options.transient ?? profile.isTransient,
			useDefaultFlags: options.useDefaultFlags ?? profile.useDefaultFlags
		}, this.defaultProfile);
		this.updateProfiles([], [], [profile]);

		return profile;
	}

	async removeProfile(profileToRemove: IUserDataProfile): Promise<void> {
		if (!this.enabled) {
			throw new Error(`Profiles are disabled in the current environment.`);
		}
		if (profileToRemove.isDefault) {
			throw new Error('Cannot remove default profile');
		}
		const profile = this.profiles.find(p => p.id === profileToRemove.id);
		if (!profile) {
			throw new Error(`Profile '${profileToRemove.name}' does not exist`);
		}

		const joiners: Promise<void>[] = [];
		this._onWillRemoveProfile.fire({
			profile,
			join(promise) {
				joiners.push(promise);
			}
		});

		try {
			await Promise.allSettled(joiners);
		} catch (error) {
			this.logService.error(error);
		}

		for (const windowId of [...this.profilesObject.emptyWindows.keys()]) {
			if (profile.id === this.profilesObject.emptyWindows.get(windowId)?.id) {
				this.profilesObject.emptyWindows.delete(windowId);
			}
		}
		for (const workspace of [...this.profilesObject.workspaces.keys()]) {
			if (profile.id === this.profilesObject.workspaces.get(workspace)?.id) {
				this.profilesObject.workspaces.delete(workspace);
			}
		}
		this.updateStoredProfileAssociations();

		this.updateProfiles([], [profile], []);

		try {
			await this.fileService.del(profile.cacheHome, { recursive: true });
		} catch (error) {
			if (toFileOperationResult(error) !== FileOperationResult.FILE_NOT_FOUND) {
				this.logService.error(error);
			}
		}
	}

	async setProfileForWorkspace(workspaceIdentifier: IAnyWorkspaceIdentifier, profileToSet: IUserDataProfile): Promise<void> {
		if (!this.enabled) {
			throw new Error(`Profiles are disabled in the current environment.`);
		}

		const profile = this.profiles.find(p => p.id === profileToSet.id);
		if (!profile) {
			throw new Error(`Profile '${profileToSet.name}' does not exist`);
		}

		this.updateWorkspaceAssociation(workspaceIdentifier, profile);
	}

	unsetWorkspace(workspaceIdentifier: IAnyWorkspaceIdentifier, transient?: boolean): void {
		if (!this.enabled) {
			throw new Error(`Profiles are disabled in the current environment.`);
		}

		this.updateWorkspaceAssociation(workspaceIdentifier, undefined, transient);
	}

	async resetWorkspaces(): Promise<void> {
		this.transientProfilesObject.folders.clear();
		this.transientProfilesObject.workspaces.clear();
		this.transientProfilesObject.emptyWindows.clear();
		this.profilesObject.workspaces.clear();
		this.profilesObject.emptyWindows.clear();
		this.updateStoredProfileAssociations();
		this._onDidResetWorkspaces.fire();
	}

	async cleanUp(): Promise<void> {
		if (!this.enabled) {
			return;
		}
		if (await this.fileService.exists(this.profilesHome)) {
			const stat = await this.fileService.resolve(this.profilesHome);
			await Promise.all((stat.children || [])
				.filter(child => child.isDirectory && this.profiles.every(p => !this.uriIdentityService.extUri.isEqual(p.location, child.resource)))
				.map(child => this.fileService.del(child.resource, { recursive: true })));
		}
	}

	async cleanUpTransientProfiles(): Promise<void> {
		if (!this.enabled) {
			return;
		}
		const unAssociatedTransientProfiles = this.transientProfilesObject.profiles.filter(p => !this.isProfileAssociatedToWorkspace(p));
		await Promise.allSettled(unAssociatedTransientProfiles.map(p => this.removeProfile(p)));
	}

	getProfileForWorkspace(workspaceIdentifier: IAnyWorkspaceIdentifier): IUserDataProfile | undefined {
		const workspace = this.getWorkspace(workspaceIdentifier);
		const profile = URI.isUri(workspace) ? this.profilesObject.workspaces.get(workspace) : this.profilesObject.emptyWindows.get(workspace);
		if (profile) {
			return profile;
		}
		if (isSingleFolderWorkspaceIdentifier(workspaceIdentifier)) {
			return this.transientProfilesObject.folders.get(workspaceIdentifier.uri);
		}
		if (isWorkspaceIdentifier(workspaceIdentifier)) {
			return this.transientProfilesObject.workspaces.get(workspaceIdentifier.configPath);
		}
		return this.transientProfilesObject.emptyWindows.get(workspaceIdentifier.id);
	}

	protected getWorkspace(workspaceIdentifier: IAnyWorkspaceIdentifier): URI | string {
		if (isSingleFolderWorkspaceIdentifier(workspaceIdentifier)) {
			return workspaceIdentifier.uri;
		}
		if (isWorkspaceIdentifier(workspaceIdentifier)) {
			return workspaceIdentifier.configPath;
		}
		return workspaceIdentifier.id;
	}

	private isProfileAssociatedToWorkspace(profile: IUserDataProfile): boolean {
		if ([...this.profilesObject.emptyWindows.values()].some(windowProfile => this.uriIdentityService.extUri.isEqual(windowProfile.location, profile.location))) {
			return true;
		}
		if ([...this.profilesObject.workspaces.values()].some(workspaceProfile => this.uriIdentityService.extUri.isEqual(workspaceProfile.location, profile.location))) {
			return true;
		}
		if ([...this.transientProfilesObject.emptyWindows.values()].some(windowProfile => this.uriIdentityService.extUri.isEqual(windowProfile.location, profile.location))) {
			return true;
		}
		if ([...this.transientProfilesObject.workspaces.values()].some(workspaceProfile => this.uriIdentityService.extUri.isEqual(workspaceProfile.location, profile.location))) {
			return true;
		}
		if ([...this.transientProfilesObject.folders.values()].some(workspaceProfile => this.uriIdentityService.extUri.isEqual(workspaceProfile.location, profile.location))) {
			return true;
		}
		return false;
	}

	private updateProfiles(added: IUserDataProfile[], removed: IUserDataProfile[], updated: IUserDataProfile[]): void {
		const allProfiles = [...this.profiles, ...added];
		const storedProfiles: StoredUserDataProfile[] = [];
		const transientProfiles = this.transientProfilesObject.profiles;
		this.transientProfilesObject.profiles = [];
		for (let profile of allProfiles) {
			if (profile.isDefault) {
				continue;
			}
			if (removed.some(p => profile.id === p.id)) {
				continue;
			}
			profile = updated.find(p => profile.id === p.id) ?? profile;
			const transientProfile = transientProfiles.find(p => profile.id === p.id);
			if (profile.isTransient) {
				this.transientProfilesObject.profiles.push(profile);
			} else {
				if (transientProfile) {
					for (const [windowId, p] of this.transientProfilesObject.emptyWindows.entries()) {
						if (profile.id === p.id) {
							this.updateWorkspaceAssociation({ id: windowId }, profile);
							break;
						}
					}
					for (const [workspace, p] of this.transientProfilesObject.workspaces.entries()) {
						if (profile.id === p.id) {
							this.updateWorkspaceAssociation({ id: '', configPath: workspace }, profile);
							break;
						}
					}
					for (const [folder, p] of this.transientProfilesObject.folders.entries()) {
						if (profile.id === p.id) {
							this.updateWorkspaceAssociation({ id: '', uri: folder }, profile);
							break;
						}
					}
				}
				storedProfiles.push({ location: profile.location, name: profile.name, shortName: profile.shortName, icon: profile.icon, useDefaultFlags: profile.useDefaultFlags });
			}
		}
		this.saveStoredProfiles(storedProfiles);
		this._profilesObject = undefined;
		this.triggerProfilesChanges(added, removed, updated);
	}

	protected triggerProfilesChanges(added: IUserDataProfile[], removed: IUserDataProfile[], updated: IUserDataProfile[]) {
		this._onDidChangeProfiles.fire({ added, removed, updated, all: this.profiles });
	}

	private updateWorkspaceAssociation(workspaceIdentifier: IAnyWorkspaceIdentifier, newProfile?: IUserDataProfile, transient?: boolean): void {
		// Force transient if the new profile to associate is transient
		transient = newProfile?.isTransient ? true : transient;

		if (transient) {
			if (isSingleFolderWorkspaceIdentifier(workspaceIdentifier)) {
				this.transientProfilesObject.folders.delete(workspaceIdentifier.uri);
				if (newProfile) {
					this.transientProfilesObject.folders.set(workspaceIdentifier.uri, newProfile);
				}
			}

			else if (isWorkspaceIdentifier(workspaceIdentifier)) {
				this.transientProfilesObject.workspaces.delete(workspaceIdentifier.configPath);
				if (newProfile) {
					this.transientProfilesObject.workspaces.set(workspaceIdentifier.configPath, newProfile);
				}
			}

			else {
				this.transientProfilesObject.emptyWindows.delete(workspaceIdentifier.id);
				if (newProfile) {
					this.transientProfilesObject.emptyWindows.set(workspaceIdentifier.id, newProfile);
				}
			}
		}

		else {
			// Unset the transiet workspace association if any
			this.updateWorkspaceAssociation(workspaceIdentifier, undefined, true);
			const workspace = this.getWorkspace(workspaceIdentifier);

			// Folder or Multiroot workspace
			if (URI.isUri(workspace)) {
				this.profilesObject.workspaces.delete(workspace);
				if (newProfile) {
					this.profilesObject.workspaces.set(workspace, newProfile);
				}
			}
			// Empty Window
			else {
				this.profilesObject.emptyWindows.delete(workspace);
				if (newProfile) {
					this.profilesObject.emptyWindows.set(workspace, newProfile);
				}
			}
			this.updateStoredProfileAssociations();
		}
	}

	private updateStoredProfileAssociations() {
		const workspaces: IStringDictionary<string> = {};
		for (const [workspace, profile] of this.profilesObject.workspaces.entries()) {
			workspaces[workspace.toString()] = profile.id;
		}
		const emptyWindows: IStringDictionary<string> = {};
		for (const [windowId, profile] of this.profilesObject.emptyWindows.entries()) {
			emptyWindows[windowId.toString()] = profile.id;
		}
		this.saveStoredProfileAssociations({ workspaces, emptyWindows });
		this._profilesObject = undefined;
	}

	// TODO: @sandy081 Remove migration after couple of releases
	protected migrateStoredProfileAssociations(storedProfileAssociations: StoredProfileAssociations): StoredProfileAssociations {
		const workspaces: IStringDictionary<string> = {};
		const defaultProfile = this.createDefaultProfile();
		if (storedProfileAssociations.workspaces) {
			for (const [workspace, location] of Object.entries(storedProfileAssociations.workspaces)) {
				const uri = URI.parse(location);
				workspaces[workspace] = this.uriIdentityService.extUri.isEqual(uri, defaultProfile.location) ? defaultProfile.id : this.uriIdentityService.extUri.basename(uri);
			}
		}
		const emptyWindows: IStringDictionary<string> = {};
		if (storedProfileAssociations.emptyWindows) {
			for (const [workspace, location] of Object.entries(storedProfileAssociations.emptyWindows)) {
				const uri = URI.parse(location);
				emptyWindows[workspace] = this.uriIdentityService.extUri.isEqual(uri, defaultProfile.location) ? defaultProfile.id : this.uriIdentityService.extUri.basename(uri);
			}
		}
		return { workspaces, emptyWindows };
	}

	protected getStoredProfiles(): StoredUserDataProfile[] { return []; }
	protected saveStoredProfiles(storedProfiles: StoredUserDataProfile[]): void { throw new Error('not implemented'); }

	protected getStoredProfileAssociations(): StoredProfileAssociations { return {}; }
	protected saveStoredProfileAssociations(storedProfileAssociations: StoredProfileAssociations): void { throw new Error('not implemented'); }
	protected getDefaultProfileExtensionsLocation(): URI | undefined { return undefined; }
}

export class InMemoryUserDataProfilesService extends UserDataProfilesService {
	private storedProfiles: StoredUserDataProfile[] = [];
	protected override getStoredProfiles(): StoredUserDataProfile[] { return this.storedProfiles; }
	protected override saveStoredProfiles(storedProfiles: StoredUserDataProfile[]): void { this.storedProfiles = storedProfiles; }

	private storedProfileAssociations: StoredProfileAssociations = {};
	protected override getStoredProfileAssociations(): StoredProfileAssociations { return this.storedProfileAssociations; }
	protected override saveStoredProfileAssociations(storedProfileAssociations: StoredProfileAssociations): void { this.storedProfileAssociations = storedProfileAssociations; }
}
