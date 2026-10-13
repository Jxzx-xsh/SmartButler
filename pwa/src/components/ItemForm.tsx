import { useState, type FormEvent } from 'react';
import type { CreateItemBody, Item } from '../api/types';
import { useCategoriesQuery } from '../hooks/useCategories';
import { dateInputValue, dateStrToMillis } from '../lib/date';
import styles from './ItemForm.module.css';

interface ItemFormProps {
  /** 编辑模式下的初始物品；不传则为新建。 */
  initialItem?: Item;
  /** 提交进行中。 */
  submitting?: boolean;
  /** 提交错误信息。 */
  errorText?: string;
  onSubmit: (body: CreateItemBody) => void;
  onCancel: () => void;
}

/** 到期设置模式：直接选到期日 / 购入日期 + 保质期天数。 */
type ExpiryMode = 'direct' | 'shelfLife';

/** 添加 / 编辑物品表单（受控）。 */
export function ItemForm({
  initialItem,
  submitting = false,
  errorText,
  onSubmit,
  onCancel,
}: ItemFormProps) {
  const categoriesQuery = useCategoriesQuery();

  const [name, setName] = useState(initialItem?.name ?? '');
  const [quantity, setQuantity] = useState(String(initialItem?.quantity ?? 1));
  const [unit, setUnit] = useState(initialItem?.unit ?? '');
  const [categoryId, setCategoryId] = useState(
    initialItem?.categoryId != null ? String(initialItem.categoryId) : '',
  );
  const [location, setLocation] = useState(initialItem?.location ?? '');
  const [note, setNote] = useState(initialItem?.note ?? '');

  // 到期设置：有购入日期+保质期则默认用 shelfLife 模式回填
  const initialMode: ExpiryMode =
    initialItem?.shelfLifeDays != null && initialItem?.purchaseDate != null
      ? 'shelfLife'
      : 'direct';
  const [expiryMode, setExpiryMode] = useState<ExpiryMode>(initialMode);
  const [expiryDate, setExpiryDate] = useState(dateInputValue(initialItem?.expiryDate ?? null));
  const [purchaseDate, setPurchaseDate] = useState(
    dateInputValue(initialItem?.purchaseDate ?? null),
  );
  const [shelfLifeDays, setShelfLifeDays] = useState(
    initialItem?.shelfLifeDays != null ? String(initialItem.shelfLifeDays) : '',
  );

  const [validationError, setValidationError] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setValidationError('');

    const trimmedName = name.trim();
    if (!trimmedName) {
      setValidationError('请填写物品名称');
      return;
    }
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) {
      setValidationError('数量需为正整数');
      return;
    }

    const body: CreateItemBody = {
      name: trimmedName,
      quantity: qty,
      source: 'manual',
    };
    body.unit = unit.trim() || null;
    body.categoryId = categoryId ? Number(categoryId) : null;
    body.location = location.trim() || null;
    body.note = note.trim() || null;

    if (expiryMode === 'direct') {
      // 直接选到期日：只传 expiryDate，清掉保质期组合
      body.expiryDate = dateStrToMillis(expiryDate);
      body.purchaseDate = null;
      body.shelfLifeDays = null;
    } else {
      // 购入日期 + 保质期：传两者，不传 expiryDate 让后端计算
      const purchaseMs = dateStrToMillis(purchaseDate);
      const shelf = shelfLifeDays ? Number(shelfLifeDays) : null;
      if (shelf !== null && (!Number.isInteger(shelf) || shelf < 0)) {
        setValidationError('保质期天数需为非负整数');
        return;
      }
      body.purchaseDate = purchaseMs;
      body.shelfLifeDays = shelf;
      body.expiryDate = null;
    }

    onSubmit(body);
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <label className={styles.field}>
        <span className={styles.label}>
          名称<span className={styles.required}>*</span>
        </span>
        <input
          className={styles.input}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="如：牛奶"
          autoFocus
        />
      </label>

      <div className={styles.grid2}>
        <label className={styles.field}>
          <span className={styles.label}>数量</span>
          <input
            className={styles.input}
            type="number"
            min={1}
            step={1}
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>单位</span>
          <input
            className={styles.input}
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="如：盒"
          />
        </label>
      </div>

      <div className={styles.grid2}>
        <label className={styles.field}>
          <span className={styles.label}>分类</span>
          <select
            className={styles.input}
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            <option value="">未分类</option>
            {categoriesQuery.data?.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>存放位置</span>
          <input
            className={styles.input}
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            placeholder="如：冰箱"
          />
        </label>
      </div>

      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>到期设置</legend>
        <div className={styles.modeTabs}>
          <label className={styles.radio}>
            <input
              type="radio"
              name="expiryMode"
              checked={expiryMode === 'direct'}
              onChange={() => setExpiryMode('direct')}
            />
            直接选到期日
          </label>
          <label className={styles.radio}>
            <input
              type="radio"
              name="expiryMode"
              checked={expiryMode === 'shelfLife'}
              onChange={() => setExpiryMode('shelfLife')}
            />
            购入日期 + 保质期
          </label>
        </div>

        {expiryMode === 'direct' ? (
          <label className={styles.field}>
            <span className={styles.label}>到期日</span>
            <input
              className={styles.input}
              type="date"
              value={expiryDate}
              onChange={(e) => setExpiryDate(e.target.value)}
            />
          </label>
        ) : (
          <div className={styles.grid2}>
            <label className={styles.field}>
              <span className={styles.label}>购入日期</span>
              <input
                className={styles.input}
                type="date"
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span className={styles.label}>保质期（天）</span>
              <input
                className={styles.input}
                type="number"
                min={0}
                step={1}
                value={shelfLifeDays}
                onChange={(e) => setShelfLifeDays(e.target.value)}
                placeholder="如：7"
              />
            </label>
          </div>
        )}
      </fieldset>

      <label className={styles.field}>
        <span className={styles.label}>备注</span>
        <textarea
          className={styles.textarea}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          placeholder="可选"
        />
      </label>

      {(validationError || errorText) && (
        <p className={styles.error}>{validationError || errorText}</p>
      )}

      <div className={styles.actions}>
        <button
          type="button"
          className={styles.cancel}
          onClick={onCancel}
          disabled={submitting}
        >
          取消
        </button>
        <button type="submit" className={styles.submit} disabled={submitting}>
          {submitting ? '提交中…' : '保存'}
        </button>
      </div>
    </form>
  );
}
