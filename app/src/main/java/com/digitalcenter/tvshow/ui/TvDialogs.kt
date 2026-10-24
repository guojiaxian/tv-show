package com.digitalcenter.tvshow.ui

import android.app.Dialog
import android.content.Context
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.view.Gravity
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import com.digitalcenter.tvshow.R
import com.digitalcenter.tvshow.databinding.DialogConfirmBinding
import com.digitalcenter.tvshow.databinding.DialogMenuBinding
import com.digitalcenter.tvshow.util.UiUtil

/**
 * 电视端对话框：统一深色样式、遥控器焦点高亮与默认焦点位置。
 */
object TvDialogs {

    private const val DIM_AMOUNT = 0.72f

    /** 对话框宽度（dp）：与 dialog_menu.xml / dialog_confirm.xml 的声明保持一致 */
    private const val MENU_WIDTH_DP = 560
    private const val CONFIRM_WIDTH_DP = 600
    /** 菜单按钮宽度（dp）：明显窄于弹窗并水平居中，避免通栏大长条 */
    private const val MENU_BTN_WIDTH_DP = 340

    /**
     * 确认对话框（用于退出确认等二次确认场景）。
     * 默认焦点落在“取消”按钮上，避免误操作。
     */
    fun confirm(
        context: Context,
        title: String,
        message: String,
        confirmText: String,
        cancelText: String,
        onConfirm: () -> Unit
    ): Dialog {
        val binding = DialogConfirmBinding.inflate(LayoutInflater.from(context))
        val dialog = prepare(context, binding.root, CONFIRM_WIDTH_DP)

        binding.dialogTitle.text = title
        binding.dialogMessage.text = message
        binding.btnConfirm.text = confirmText
        binding.btnCancel.text = cancelText

        listOf(binding.btnCancel, binding.btnConfirm).forEach {
            UiUtil.attachFocusAnimation(it, 1.06f)
        }
        binding.btnCancel.setOnClickListener { dialog.dismiss() }
        binding.btnConfirm.setOnClickListener {
            dialog.dismiss()
            onConfirm()
        }

        dialog.setOnShowListener { binding.btnCancel.requestFocus() }
        return dialog
    }

    /**
     * 菜单对话框：垂直列表，方向键上下切换，确定键触发。
     */
    fun menu(
        context: Context,
        title: String,
        subtitle: String,
        items: List<String>,
        onSelected: (Int) -> Unit
    ): Dialog {
        val binding = DialogMenuBinding.inflate(LayoutInflater.from(context))
        val dialog = prepare(context, binding.root, MENU_WIDTH_DP)

        binding.menuTitle.text = title
        binding.menuSubtitle.text = subtitle
        binding.menuContainer.removeAllViews()

        var firstButton: View? = null
        items.forEachIndexed { index, label ->
            val button = TextView(context, null, 0, R.style.TvDialogButton).apply {
                text = label
                isFocusable = true
                isFocusableInTouchMode = true
                isClickable = true
            }
            UiUtil.attachFocusAnimation(button, 1.04f)

            val lp = LinearLayout.LayoutParams(
                UiUtil.dp(context, MENU_BTN_WIDTH_DP.toFloat()),
                context.resources.getDimensionPixelSize(R.dimen.dialog_btn_height)
            ).apply {
                gravity = Gravity.CENTER_HORIZONTAL
                if (index > 0) topMargin = UiUtil.dp(context, 14f)
            }

            button.setOnClickListener {
                dialog.dismiss()
                onSelected(index)
            }
            binding.menuContainer.addView(button, lp)
            if (index == 0) firstButton = button
        }

        dialog.setOnShowListener { firstButton?.requestFocus() }
        return dialog
    }

    /**
     * 统一准备对话框窗口。
     *
     * 必须显式 [android.view.Window.setLayout] 指定宽度：`inflate(layout, null, false)`
     * 会丢掉 XML 里的 layout_width，而 `setContentView` 又用 MATCH_PARENT 覆盖一次，
     * 浮窗最终按 wrap_content 测量 → 宽度缩成文本固有宽度，标题被挤断、副标题被省略号截掉。
     */
    private fun prepare(context: Context, content: View, widthDp: Int): Dialog {
        val dialog = Dialog(context, R.style.TvDialogTheme)
        dialog.setContentView(content)
        dialog.setCanceledOnTouchOutside(false)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            val attrs = attributes
            attrs.dimAmount = DIM_AMOUNT
            attributes = attrs
            setLayout(UiUtil.dp(context, widthDp.toFloat()), ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        return dialog
    }
}
