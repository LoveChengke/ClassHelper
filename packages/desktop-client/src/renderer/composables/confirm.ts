import { ElMessageBox } from 'element-plus';

/** 取消是正常交互；真实异常继续交给调用方处理。 */
export async function confirmAction(...args: Parameters<typeof ElMessageBox.confirm>): Promise<boolean> {
  try {
    await ElMessageBox.confirm(...args);
    return true;
  } catch (reason) {
    if (reason === 'cancel' || reason === 'close') return false;
    throw reason;
  }
}
