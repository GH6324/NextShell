import { useCallback, useRef, useState } from "react";
import { App as AntdApp, Form, Input, Modal } from "antd";
import type { SshKeyProfile } from "@nextshell/core";
import { formatErrorMessage } from "../../../utils/errorMessage";

interface InlineSshKeyCreateModalProps {
  open: boolean;
  /** 连接表单当前所在的 workspace；本地连接为 undefined，密钥保存到相同作用域。 */
  workspaceId?: string;
  onClose: () => void;
  /** 创建成功后回调，调用方负责刷新密钥列表并选中新密钥。 */
  onCreated: (key: SshKeyProfile) => Promise<void> | void;
}

interface InlineSshKeyFormValues {
  name: string;
  keyContent: string;
  passphrase?: string;
}

/**
 * 新建连接流程内的快捷密钥创建：让用户不必先绕到「密钥」标签页
 * 建好密钥再回来绑定。作用域跟随连接表单（本地/workspace），不提供切换。
 */
export const InlineSshKeyCreateModal = ({
  open,
  workspaceId,
  onClose,
  onCreated
}: InlineSshKeyCreateModalProps) => {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<InlineSshKeyFormValues>();
  const [saving, setSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result;
        if (typeof text !== "string") return;
        form.setFieldValue("keyContent", text);
        if (!form.getFieldValue("name")) {
          form.setFieldValue("name", file.name.replace(/\.[^.]*$/, ""));
        }
        message.success(`已从文件「${file.name}」导入私钥`);
      };
      reader.onerror = () => {
        message.error("读取文件失败，请重试");
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [form, message]
  );

  const handleFinish = useCallback(
    async (values: InlineSshKeyFormValues) => {
      const name = values.name.trim();
      const keyContent = values.keyContent.trim();
      if (!name || !keyContent) {
        return;
      }
      setSaving(true);
      try {
        const created = await window.nextshell.sshKey.upsert({
          name,
          keyContent,
          passphrase: values.passphrase?.trim() || undefined,
          workspaceId
        });
        await onCreated(created);
        message.success(`密钥「${created.name}」已创建并选中`);
        form.resetFields();
        onClose();
      } catch (error) {
        message.error(`创建密钥失败：${formatErrorMessage(error, "请检查私钥内容")}`);
      } finally {
        setSaving(false);
      }
    },
    [form, message, onClose, onCreated, workspaceId]
  );

  return (
    <Modal
      title="新建 SSH 密钥"
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      okText="创建并选用"
      cancelText="取消"
      confirmLoading={saving}
      destroyOnHidden
      width={480}
    >
      <input
        ref={fileInputRef}
        type="file"
        aria-label="选择私钥文件"
        className="sr-only"
        onChange={handleFileChange}
      />
      <Form form={form} layout="vertical" requiredMark={false} onFinish={handleFinish}>
        <Form.Item label="名称" name="name" rules={[{ required: true, message: "请输入密钥名称" }]}>
          <Input placeholder="my-server-key" autoFocus />
        </Form.Item>
        <Form.Item
          label={
            <span className="mgr-key-label">
              <span>私钥内容</span>
              <button
                type="button"
                className="mgr-import-file-btn"
                onClick={() => fileInputRef.current?.click()}
              >
                <i className="ri-folder-open-line" aria-hidden="true" />
                从文件导入
              </button>
            </span>
          }
          name="keyContent"
          rules={[{ required: true, message: "请粘贴私钥内容或从文件导入" }]}
        >
          <Input.TextArea
            rows={6}
            placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
            className="mgr-mono-input"
          />
        </Form.Item>
        <Form.Item label="Passphrase（可选）" name="passphrase">
          <Input.Password placeholder="留空表示无 Passphrase" />
        </Form.Item>
      </Form>
    </Modal>
  );
};
