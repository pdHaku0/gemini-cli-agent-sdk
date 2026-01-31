import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

export type PermissionOutcome = 'allow' | 'deny' | 'ask';

export interface ToolSettings {
    tools: {
        yolo: boolean;
        allowAlways: string[];
        denyAlways: string[];
    };
}

export interface PermissionRequest {
    toolCallId: string;
    kind: string; // 'execute' or 'search' etc.
    title: string; // "ls -F ..."
}

export class ToolPermissionManager extends EventEmitter {
    private settingsPath: string;
    private settings: ToolSettings;

    constructor(settingsPath?: string) {
        super();
        this.settingsPath = settingsPath || path.resolve(process.cwd(), 'settings.json');
        this.settings = this.loadSettings();
    }

    private loadSettings(): ToolSettings {
        try {
            if (fs.existsSync(this.settingsPath)) {
                const raw = fs.readFileSync(this.settingsPath, 'utf8');
                return JSON.parse(raw);
            }
        } catch (error) {
            console.warn('[ToolPermissionManager] Failed to load settings, using default.', error);
        }
        return {
            tools: {
                yolo: false,
                allowAlways: [],
                denyAlways: []
            }
        };
    }

    private saveSettings() {
        try {
            const dir = path.dirname(this.settingsPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
        } catch (error) {
            console.error('[ToolPermissionManager] Failed to save settings.', error);
        }
    }

    public getCommandKey(req: PermissionRequest): string {
        // Simple heuristic: extract command name from title if possible
        // Title format often: "check_file_exists [path] (Check if file...)"
        // or "ls [path] (List files...)"

        // This logic mimics server/permissions logic simply for now
        // We use the first word of the title as the command key usually
        const rawLabel = req.title || req.kind;
        const command = (rawLabel || '').split(' ')[0];
        return command;
    }

    public checkPermission(req: PermissionRequest): PermissionOutcome {
        const cmdKey = this.getCommandKey(req);

        if (this.settings.tools.denyAlways.includes(cmdKey)) {
            return 'deny';
        }
        if (this.settings.tools.allowAlways.includes(cmdKey)) {
            return 'allow';
        }
        if (this.settings.tools.yolo) {
            return 'allow';
        }

        return 'ask';
    }

    public grantAlways(req: PermissionRequest) {
        const cmdKey = this.getCommandKey(req);
        if (!this.settings.tools.allowAlways.includes(cmdKey)) {
            this.settings.tools.allowAlways.push(cmdKey);
            // Remove from deny list if present
            this.settings.tools.denyAlways = this.settings.tools.denyAlways.filter(k => k !== cmdKey);
            this.saveSettings();
        }
    }

    public denyAlways(req: PermissionRequest) {
        const cmdKey = this.getCommandKey(req);
        if (!this.settings.tools.denyAlways.includes(cmdKey)) {
            this.settings.tools.denyAlways.push(cmdKey);
            // Remove from allow list if present
            this.settings.tools.allowAlways = this.settings.tools.allowAlways.filter(k => k !== cmdKey);
            this.saveSettings();
        }
    }

    public setYolo(enabled: boolean) {
        this.settings.tools.yolo = enabled;
        this.saveSettings();
    }
}
