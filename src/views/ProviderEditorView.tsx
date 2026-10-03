import { useState } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  Trash2,
  Lock,
  Eye,
  EyeOff,
  RefreshCw,
  Plus,
  ShieldCheck,
  Clock,
  Gauge,
  Info,
  Check,
  ArrowRightLeft,
  ChevronDown,
} from "lucide-react";
import type { Provider } from "@/types";

export interface ProviderEditorData {
  id?: string;
  name?: string;
  baseUrl?: string;
  model?: string;
  [key: string]: any;
}

export interface ProviderEditorViewProps {
  provider?: ProviderEditorData | Partial<Provider> | null;
  onSave?: (provider: ProviderEditorData, andSwitch?: boolean) => void;
  onCancel?: () => void;
  onDelete?: (id?: string) => void;
}

export function ProviderEditorView({
  provider,
  onSave,
  onCancel,
  onDelete,
}: ProviderEditorViewProps) {
  const [name, setName] = useState(provider?.name ?? "自建中转");
  const [endpoint, setEndpoint] = useState(
    (provider as any)?.baseUrl ?? "https://gw.lab.internal:8443/v1",
  );
  const [apiKey, setApiKey] = useState("sk-test-849204c81e");
  const [showKey, setShowKey] = useState(false);
  const [protocol, setProtocol] = useState<
    "auto" | "responses" | "chat" | "anthropic"
  >("auto");
  const [defaultModel, setDefaultModel] = useState(
    (provider as any)?.model ?? "claude-sonnet-4-6",
  );
  const [oneMillionContext, setOneMillionContext] = useState(true);
  const [testStatus, setTestStatus] = useState<
    "idle" | "testing" | "success" | "failed"
  >("idle");
  const [testingLatency, setTestingLatency] = useState<number | null>(null);

  // 模型映射行
  const [mappings, setMappings] = useState([
    {
      id: "map-1",
      displayName: "Sonnet 4.6 · 1M",
      targetModel: "claude-sonnet-4-6",
      context: "1M",
      reasoning: "自动",
    },
    {
      id: "map-2",
      displayName: "Haiku 4.5",
      targetModel: "claude-haiku-4-5",
      context: "200K",
      reasoning: "低",
    },
  ]);

  const handleTestConnection = () => {
    setTestStatus("testing");
    toast.loading("正在测试端点连接与测速...", { id: "test-conn" });
    setTimeout(() => {
      setTestStatus("success");
      setTestingLatency(168);
      toast.success("端点连接正常 · 延迟 168 ms", { id: "test-conn" });
    }, 800);
  };

  const handleAddMapping = () => {
    setMappings([
      ...mappings,
      {
        id: `map-${Date.now()}`,
        displayName: "新映射模型",
        targetModel: "gpt-5.5",
        context: "128K",
        reasoning: "自动",
      },
    ]);
  };

  const handleRemoveMapping = (id: string) => {
    setMappings(mappings.filter((m) => m.id !== id));
  };

  const handleSave = (andSwitch = false) => {
    toast.success(andSwitch ? "线路已保存并立即激活切换" : "线路配置已保存", {
      description: `已更新 ${name} 的本地代理规则与模型映射。`,
    });
    onSave?.(
      {
        ...provider,
        name,
        baseUrl: endpoint,
        model: defaultModel,
      },
      andSwitch,
    );
  };

  return (
    <div
      data-pencil-name="02 线路编辑"
      className="box-border w-full h-full flex flex-col gap-0 justify-start items-start bg-[#FDFDFE] dark:bg-[#171C21] overflow-hidden"
    >
      {/* 顶部标题栏 */}
      <div
        data-pencil-name="编辑头"
        className="box-border w-full h-[52px] shrink-0 flex flex-row gap-[12px] px-[24px] justify-start items-center border-b border-[#DDE0E3] dark:border-[#31363D]"
      >
        <button
          type="button"
          data-pencil-name="返回"
          onClick={onCancel}
          className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[10px] justify-center items-center bg-transparent border-0 cursor-pointer rounded-[4px] hover:bg-[#F2F4F6] dark:hover:bg-[#23282D] text-[#12161C] dark:text-[#EEF0F3]"
        >
          <ArrowLeft size={16} />
          <span className="text-[14px]/[20px] font-normal">线路</span>
        </button>
        <div className="box-border w-[1px] shrink-0 h-[20px] bg-[#DDE0E3] dark:bg-[#31363D]" />

        {/* 徽标 */}
        <div className="box-border w-[24px] shrink-0 h-[24px] flex items-center justify-center bg-[#8F6446] rounded-[4px]">
          <span className="text-[12px]/[17px] text-[#FDFDFE] font-bold">
            {name.slice(0, 1)}
          </span>
        </div>

        <span className="text-[18px]/[23px] text-[#12161C] dark:text-[#EEF0F3] font-bold">
          {name}
        </span>
        <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
          编辑线路
        </span>

        <div className="box-border w-fit shrink-0 h-[22px] flex flex-row gap-[4px] px-[8px] justify-start items-center bg-[#FEF1D6] dark:bg-[#3E2C0F] outline outline-1 outline-[#EABC6E] dark:outline-[#8F6446] -outline-offset-1 rounded-full">
          <span className="text-[12px]/[17px] text-[#915C08] dark:text-[#EABC6E] font-bold">
            2 处未保存
          </span>
        </div>

        <div className="flex-1" />

        {/* 删除线路 */}
        <button
          type="button"
          data-pencil-name="删除线路"
          onClick={() => {
            if (provider?.id) onDelete?.(provider.id);
            else toast.info("已取消新建线路");
          }}
          className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-transparent border-0 cursor-pointer rounded-[4px] hover:bg-[#BE2323]/10 text-[#BE2323] dark:text-[#F85149]"
        >
          <Trash2 size={16} />
          <span className="text-[14px]/[20px]">删除线路</span>
        </button>
        <div className="box-border w-[1px] shrink-0 h-[16px] bg-[#DDE0E3] dark:bg-[#31363D]" />

        <div className="box-border w-fit shrink-0 h-[20px] px-[6px] flex items-center justify-center bg-[#FDFDFE] dark:bg-[#23282D] outline outline-1 outline-[#DDE0E3] dark:outline-[#31363D] -outline-offset-1 rounded-[4px]">
          <span className="text-[12px]/[17px] text-[#646970] dark:text-[#8D9398] font-mono">
            Esc
          </span>
        </div>
        <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
          返回
        </span>
      </div>

      {/* 主体双栏区域 */}
      <div
        data-pencil-name="主区"
        className="box-border w-full flex-1 flex flex-row gap-[24px] p-[16px_24px] justify-start items-start overflow-y-auto"
      >
        {/* 左侧表单 */}
        <div
          data-pencil-name="表单"
          className="box-border flex-1 h-fit flex flex-col gap-[24px] justify-start items-start"
        >
          {/* 基础组 */}
          <div
            data-pencil-name="组 · 基础"
            className="box-border w-full h-fit shrink-0 flex flex-col gap-[12px] justify-start items-start"
          >
            <div className="text-[15px]/[21px] text-[#12161C] dark:text-[#EEF0F3] font-bold">
              基础
            </div>

            {/* 名称行 */}
            <div className="box-border w-full h-fit flex flex-row gap-[12px] justify-start items-end">
              <div className="box-border flex-1 flex flex-col gap-[6px]">
                <label className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]">
                  线路名称
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="box-border w-full h-[36px] px-[12px] bg-[#FDFDFE] dark:bg-[#1A1E24] text-[#12161C] dark:text-[#EEF0F3] text-[14px] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px]"
                />
              </div>

              {/* 外观折叠 */}
              <div className="box-border w-[272px] shrink-0 h-[36px] flex flex-row gap-[10px] px-[12px] justify-start items-center bg-[#F2F4F6] dark:bg-[#23282D] rounded-[4px]">
                <span className="text-[13px]/[18px] text-[#484E55] dark:text-[#94999E]">
                  外观
                </span>
                <div className="box-border w-[20px] shrink-0 h-[20px] flex items-center justify-center bg-[#8F6446] rounded-[4px]">
                  <span className="text-[12px]/[17px] text-[#FDFDFE] font-bold">
                    {name.slice(0, 1)}
                  </span>
                </div>
                <span className="text-[13px]/[18px] flex-1 text-[#484E55] dark:text-[#BABEC3] truncate">
                  赭石 · 自动生成
                </span>
                <button
                  type="button"
                  onClick={() => toast.info("外观定制调色板")}
                  className="flex flex-row gap-[4px] items-center text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] bg-transparent border-0 cursor-pointer"
                >
                  <span>修改</span>
                  <ChevronDown size={14} />
                </button>
              </div>
            </div>

            {/* 请求地址 */}
            <div className="box-border w-full flex flex-col gap-[6px]">
              <div className="w-full flex flex-row justify-between items-center">
                <label className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]">
                  请求地址
                </label>
                <span className="text-[13px]/[18px] text-[#915C08] dark:text-[#EABC6E]">
                  已修改
                </span>
              </div>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                className="box-border w-full h-[36px] px-[12px] bg-[#FDFDFE] dark:bg-[#1A1E24] text-[#12161C] dark:text-[#EEF0F3] font-mono text-[13px] outline outline-1 outline-[#006AA0] dark:outline-[#388BFD] -outline-offset-1 rounded-[4px]"
              />
            </div>

            {/* API 密钥 */}
            <div className="box-border w-full flex flex-col gap-[6px]">
              <label className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]">
                API 密钥
              </label>
              <div className="box-border w-full h-[36px] flex flex-row gap-[8px] pl-[12px] pr-[4px] items-center bg-[#FDFDFE] dark:bg-[#1A1E24] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px]">
                <Lock
                  size={16}
                  className="text-[#646970] dark:text-[#8D9398] shrink-0"
                />
                <input
                  type={showKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  className="flex-1 h-full bg-transparent border-0 text-[#12161C] dark:text-[#EEF0F3] font-mono text-[13px] outline-none"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="h-[28px] px-[8px] flex items-center gap-[4px] bg-transparent border-0 cursor-pointer text-[13px] text-[#12161C] dark:text-[#EEF0F3] hover:bg-[#DDE0E3]/50 dark:hover:bg-[#31363D] rounded"
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                  <span>{showKey ? "隐藏" : "显示"}</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setApiKey("");
                    toast.info("已清空凭据，请输入新密钥");
                  }}
                  className="h-[28px] px-[8px] flex items-center gap-[4px] bg-transparent border-0 cursor-pointer text-[13px] text-[#12161C] dark:text-[#EEF0F3] hover:bg-[#DDE0E3]/50 dark:hover:bg-[#31363D] rounded"
                >
                  <RefreshCw size={14} />
                  <span>替换</span>
                </button>
              </div>
              <div className="w-full flex flex-row gap-[6px] items-center text-[13px]/[18px] text-[#05773B] dark:text-[#7EE787]">
                <ShieldCheck size={14} />
                <span>
                  已保存在系统凭据库，不写入 config.toml · 昨天 21:14 验证通过
                </span>
              </div>
            </div>
          </div>

          {/* 协议与模型组 */}
          <div
            data-pencil-name="组 · 协议与模型"
            className="box-border w-full h-fit shrink-0 flex flex-col gap-[12px] justify-start items-start"
          >
            <div className="text-[15px]/[21px] text-[#12161C] dark:text-[#EEF0F3] font-bold">
              协议与模型
            </div>

            {/* 协议分段 */}
            <div className="box-border w-full flex flex-col gap-[6px]">
              <label className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]">
                协议
              </label>
              <div className="w-full flex flex-row gap-[12px] items-center">
                <div className="box-border w-fit h-[32px] flex flex-row gap-[2px] p-[2px] justify-start items-center bg-[#ECEFF2] dark:bg-[#23282D] rounded-[4px]">
                  {[
                    { id: "auto", label: "自动" },
                    { id: "responses", label: "Responses" },
                    { id: "chat", label: "Chat" },
                    { id: "anthropic", label: "Anthropic" },
                  ].map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setProtocol(p.id as any)}
                      className={`box-border w-fit h-[28px] px-[12px] flex items-center justify-center rounded-[2px] border-0 cursor-pointer text-[14px]/[20px] transition-colors ${
                        protocol === p.id
                          ? "bg-[#FDFDFE] dark:bg-[#171C21] text-[#12161C] dark:text-[#EEF0F3] font-bold shadow-sm outline outline-1 outline-[#81878D]/40"
                          : "bg-transparent text-[#484E55] dark:text-[#BABEC3] font-normal"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <span className="text-[13px]/[18px] text-[#484E55] dark:text-[#94999E]">
                  → 按模型族推断为 Anthropic
                </span>
              </div>
            </div>

            {/* 模型行 */}
            <div className="box-border w-full flex flex-row gap-[12px] items-end">
              <div className="flex-1 flex flex-col gap-[6px]">
                <label className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]">
                  默认模型
                </label>
                <select
                  value={defaultModel}
                  onChange={(e) => setDefaultModel(e.target.value)}
                  className="box-border w-full h-[36px] px-[12px] bg-[#FDFDFE] dark:bg-[#1A1E24] text-[#12161C] dark:text-[#EEF0F3] font-mono text-[13px] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px] cursor-pointer"
                >
                  <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
                  <option value="claude-haiku-4-5">claude-haiku-4-5</option>
                  <option value="claude-opus-4-6">claude-opus-4-6</option>
                  <option value="gpt-5.5">gpt-5.5</option>
                </select>
              </div>

              <button
                type="button"
                onClick={() => toast.success("已成功获取 18 个上游模型")}
                className="box-border w-fit shrink-0 h-[36px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[#FDFDFE] dark:bg-[#23282D] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px] cursor-pointer text-[#12161C] dark:text-[#EEF0F3] text-[14px]"
              >
                <RefreshCw size={14} />
                <span>获取模型</span>
              </button>

              <div className="box-border w-fit flex flex-col gap-[6px]">
                <div className="flex flex-row gap-[8px] items-center">
                  <span className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]">
                    上下文
                  </span>
                  <span className="text-[13px]/[18px] text-[#915C08] dark:text-[#EABC6E]">
                    已修改
                  </span>
                </div>
                <div className="h-[36px] flex items-center">
                  <button
                    type="button"
                    onClick={() => setOneMillionContext(!oneMillionContext)}
                    className="flex flex-row gap-[10px] items-center bg-transparent border-0 cursor-pointer"
                  >
                    <div
                      className={`box-border w-[36px] h-[20px] p-[4px] flex items-center rounded-full transition-colors ${
                        oneMillionContext
                          ? "bg-[#12161C] dark:bg-[#388BFD] justify-end"
                          : "bg-[#FDFDFE] outline outline-1 outline-[#81878D] justify-start"
                      }`}
                    >
                      <div className="w-[12px] h-[12px] rounded-full bg-[#FDFDFE]" />
                    </div>
                    <span className="text-[14px]/[20px] text-[#12161C] dark:text-[#EEF0F3]">
                      1M 上下文
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 模型映射组 */}
          <div
            data-pencil-name="组 · 模型映射"
            className="box-border w-full h-fit shrink-0 flex flex-col gap-[8px] justify-start items-start"
          >
            <div className="w-full flex flex-row gap-[8px] items-center">
              <div className="text-[15px]/[21px] text-[#12161C] dark:text-[#EEF0F3] font-bold">
                模型映射
              </div>
              <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398] font-mono">
                {mappings.length}
              </span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={handleAddMapping}
                className="h-[28px] px-[8px] flex items-center gap-[4px] bg-transparent border-0 cursor-pointer text-[13px] text-[#12161C] dark:text-[#EEF0F3] hover:bg-[#DDE0E3]/50 dark:hover:bg-[#31363D] rounded"
              >
                <Plus size={14} />
                <span>添加映射</span>
              </button>
            </div>

            {/* 表头 */}
            <div className="box-border w-full h-[20px] flex flex-row gap-[8px] items-center text-[12px] text-[#646970] dark:text-[#8D9398]">
              <div className="flex-1">菜单显示名</div>
              <div className="flex-1">实际请求模型</div>
              <div className="w-[64px]">上下文</div>
              <div className="w-[84px]">思考等级</div>
              <div className="w-[28px]" />
            </div>

            {/* 映射行列表 */}
            {mappings.map((m) => (
              <div
                key={m.id}
                className="box-border w-full h-[36px] flex flex-row gap-[8px] items-center"
              >
                <input
                  type="text"
                  value={m.displayName}
                  onChange={(e) => {
                    const val = e.target.value;
                    setMappings(
                      mappings.map((item) =>
                        item.id === m.id ? { ...item, displayName: val } : item,
                      ),
                    );
                  }}
                  className="flex-1 h-[32px] px-[10px] bg-[#FDFDFE] dark:bg-[#1A1E24] text-[#12161C] dark:text-[#EEF0F3] text-[13px] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px]"
                />
                <input
                  type="text"
                  value={m.targetModel}
                  onChange={(e) => {
                    const val = e.target.value;
                    setMappings(
                      mappings.map((item) =>
                        item.id === m.id ? { ...item, targetModel: val } : item,
                      ),
                    );
                  }}
                  className="flex-1 h-[32px] px-[10px] bg-[#FDFDFE] dark:bg-[#1A1E24] text-[#12161C] dark:text-[#EEF0F3] font-mono text-[13px] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px]"
                />
                <input
                  type="text"
                  value={m.context}
                  onChange={(e) => {
                    const val = e.target.value;
                    setMappings(
                      mappings.map((item) =>
                        item.id === m.id ? { ...item, context: val } : item,
                      ),
                    );
                  }}
                  className="w-[64px] h-[32px] px-[8px] bg-[#FDFDFE] dark:bg-[#1A1E24] text-[#12161C] dark:text-[#EEF0F3] font-mono text-[13px] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px]"
                />
                <select
                  value={m.reasoning}
                  onChange={(e) => {
                    const val = e.target.value;
                    setMappings(
                      mappings.map((item) =>
                        item.id === m.id ? { ...item, reasoning: val } : item,
                      ),
                    );
                  }}
                  className="w-[84px] h-[32px] px-[6px] bg-[#FDFDFE] dark:bg-[#1A1E24] text-[#12161C] dark:text-[#EEF0F3] text-[13px] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px] cursor-pointer"
                >
                  <option value="自动">自动</option>
                  <option value="低">低</option>
                  <option value="中">中</option>
                  <option value="高">高</option>
                </select>
                <button
                  type="button"
                  onClick={() => handleRemoveMapping(m.id)}
                  aria-label="删除映射"
                  className="w-[28px] h-[28px] flex items-center justify-center bg-transparent border-0 cursor-pointer text-[#484E55] dark:text-[#8D9398] hover:text-[#BE2323] rounded"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* 右侧预览面板 (320px) */}
        <div
          data-pencil-name="预览"
          className="box-border w-[320px] shrink-0 h-fit flex flex-col gap-[12px] p-[16px] justify-start items-start bg-[#F5F7F9] dark:bg-[#1A1E24] outline outline-1 outline-[#DDE0E3] dark:outline-[#31363D] -outline-offset-1 rounded-[8px]"
        >
          <div className="text-[13px]/[18px] text-[#484E55] dark:text-[#94999E] font-bold">
            保存后的线路
          </div>

          {/* 4 节点竖向路径 */}
          <div className="box-border w-full flex flex-col gap-0 select-none">
            {/* 站 1: Codex */}
            <div className="w-full h-[50px] flex flex-row gap-[12px]">
              <div className="w-[12px] h-full flex flex-col items-center">
                <div className="w-[12px] h-[12px] bg-[#F5F7F9] dark:bg-[#1A1E24] border-2 border-[#8F6446] rounded-full" />
                <div className="w-[2px] flex-1 bg-[#8F6446]" />
              </div>
              <div className="flex-1 flex flex-col">
                <span className="text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] font-bold">
                  Codex
                </span>
                <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                  CLI 0.61.0
                </span>
              </div>
            </div>

            {/* 站 2: 本地代理 */}
            <div className="w-full h-[50px] flex flex-row gap-[12px]">
              <div className="w-[12px] h-full flex flex-col items-center">
                <div className="w-[12px] h-[12px] bg-[#F5F7F9] dark:bg-[#1A1E24] border-2 border-[#8F6446] rounded-full" />
                <div className="w-[2px] flex-1 bg-[#8F6446]" />
              </div>
              <div className="flex-1 flex flex-col">
                <span className="text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] font-bold">
                  本地代理
                </span>
                <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                  Responses → Anthropic
                </span>
              </div>
            </div>

            {/* 站 3: 端点 */}
            <div className="w-full h-[50px] flex flex-row gap-[12px]">
              <div className="w-[12px] h-full flex flex-col items-center">
                <div className="w-[12px] h-[12px] bg-[#F5F7F9] dark:bg-[#1A1E24] border-2 border-[#8F6446] rounded-full" />
                <div className="w-[2px] flex-1 bg-[#8F6446]" />
              </div>
              <div className="flex-1 flex flex-col">
                <span className="text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] font-mono">
                  gw.lab.internal:8443
                </span>
                <span className="text-[13px]/[18px] text-[#915C08] dark:text-[#EABC6E]">
                  {testStatus === "success"
                    ? `已测试 · ${testingLatency} ms`
                    : "新地址，尚未测试"}
                </span>
              </div>
            </div>

            {/* 站 4: 模型 */}
            <div className="w-full h-[40px] flex flex-row gap-[12px]">
              <div className="w-[12px] h-full flex flex-col items-center">
                <div className="w-[12px] h-[12px] bg-[#8F6446] border-2 border-[#8F6446] rounded-full" />
              </div>
              <div className="flex-1 flex flex-col">
                <span className="text-[13px]/[18px] text-[#12161C] dark:text-[#EEF0F3] font-mono">
                  {defaultModel}
                </span>
                <span className="text-[13px]/[18px] text-[#646970] dark:text-[#8D9398]">
                  默认模型 · {oneMillionContext ? "1M 上下文" : "标准上下文"}
                </span>
              </div>
            </div>
          </div>

          <div className="w-full h-[1px] bg-[#DDE0E3] dark:bg-[#31363D]" />

          {/* 写入预告 */}
          <div className="text-[13px]/[18px] text-[#484E55] dark:text-[#94999E] font-bold">
            写入预告
          </div>
          <div className="text-[12px]/[16px] text-[#646970] dark:text-[#8D9398] font-bold">
            点「保存」时写入
          </div>
          <div className="w-full flex flex-col gap-[2px]">
            <span className="text-[12px] font-mono text-[#12161C] dark:text-[#EEF0F3]">
              %APPDATA%\Chimera\routes.json
            </span>
            <span className="text-[12px] text-[#484E55] dark:text-[#BABEC3]">
              请求地址、上下文，共 2 处
            </span>
          </div>

          <div className="text-[12px]/[16px] text-[#646970] dark:text-[#8D9398] font-bold mt-[4px]">
            点「保存并切换」时还会写入
          </div>
          <div className="w-full flex flex-col gap-[4px]">
            <span className="text-[12px] font-mono text-[#12161C] dark:text-[#EEF0F3]">
              C:\Users\lin\.codex\config.toml
            </span>
            {/* 代码 diff 预览 */}
            <div className="w-full p-[8px] rounded bg-[#FDFDFE] dark:bg-[#171C21] border border-[#DDE0E3] dark:border-[#31363D] font-mono text-[11px] leading-[16px]">
              <div className="text-[#BE2323]">
                - model_provider = "deepseek"
              </div>
              <div className="text-[#05773B]">
                + model_provider = "relay-gw"
              </div>
              <div className="text-[#BE2323]">- model = "deepseek-v4-pro"</div>
              <div className="text-[#05773B]">+ model = "{defaultModel}"</div>
              {oneMillionContext && (
                <div className="text-[#05773B]">
                  + model_context_window = 1000000
                </div>
              )}
            </div>
          </div>

          {/* 保证提示 */}
          <div className="w-full flex flex-col gap-[6px] mt-[4px] text-[12px] text-[#646970] dark:text-[#8D9398]">
            <div className="flex flex-row gap-[6px] items-center">
              <ShieldCheck size={14} />
              <span>密钥只存在系统凭据库，不写入任何文件</span>
            </div>
            <div className="flex flex-row gap-[6px] items-center">
              <Clock size={14} />
              <span>写入前自动备份，可在「设置 › 备份与恢复」里撤销</span>
            </div>
          </div>
        </div>
      </div>

      {/* 底部操作栏 */}
      <div
        data-pencil-name="底栏"
        className="box-border w-full h-[52px] shrink-0 flex flex-row gap-[8px] px-[24px] justify-start items-center bg-[#FDFDFE] dark:bg-[#1A1E24] border-t border-[#DDE0E3] dark:border-[#31363D]"
      >
        <button
          type="button"
          data-pencil-name="测试连接"
          onClick={handleTestConnection}
          className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[#FDFDFE] dark:bg-[#23282D] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px] cursor-pointer hover:bg-[#F2F4F6] dark:hover:bg-[#2C3238] transition-colors border-0 text-[#12161C] dark:text-[#EEF0F3]"
        >
          <Gauge size={16} />
          <span className="text-[14px]/[20px]">测试连接</span>
        </button>

        <div className="flex flex-row gap-[6px] items-center pl-[4px] text-[13px]/[18px] text-[#484E55] dark:text-[#BABEC3]">
          <Info size={14} className="text-[#646970]" />
          <span>
            {testStatus === "success"
              ? `已通过握手测试 · 延迟 ${testingLatency} ms`
              : "新地址尚未测试 · 选「保存并切换」会先测速，不通就不切换"}
          </span>
        </div>

        <div className="flex-1" />

        <button
          type="button"
          data-pencil-name="保存"
          onClick={() => handleSave(false)}
          className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[#006AA0] dark:bg-[#1F6FEB] rounded-[4px] border-0 cursor-pointer text-[#FDFDFE] hover:opacity-90"
        >
          <Check size={16} />
          <span className="text-[14px]/[20px]">保存</span>
        </button>

        <button
          type="button"
          data-pencil-name="保存并切换"
          onClick={() => handleSave(true)}
          className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[#FDFDFE] dark:bg-[#23282D] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px] cursor-pointer hover:bg-[#F2F4F6] dark:hover:bg-[#2C3238] border-0 text-[#12161C] dark:text-[#EEF0F3]"
        >
          <ArrowRightLeft size={16} />
          <span className="text-[14px]/[20px]">保存并切换</span>
        </button>

        <button
          type="button"
          data-pencil-name="取消"
          onClick={onCancel}
          className="box-border w-fit shrink-0 h-[32px] flex flex-row gap-[6px] px-[12px] justify-center items-center bg-[#FDFDFE] dark:bg-[#23282D] outline outline-1 outline-[#81878D] dark:outline-[#484E55] -outline-offset-1 rounded-[4px] cursor-pointer hover:bg-[#F2F4F6] dark:hover:bg-[#2C3238] border-0 text-[#12161C] dark:text-[#EEF0F3]"
        >
          <span className="text-[14px]/[20px]">取消</span>
        </button>
      </div>
    </div>
  );
}

export default ProviderEditorView;
