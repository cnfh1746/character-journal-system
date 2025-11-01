/**
 * 新布局处理器 - 标签页和设置窗口逻辑
 * 用于处理新的精简主面板 + 独立设置窗口布局
 */

(function() {
    'use strict';

    // ========== 标签页切换逻辑 ==========
    function initTabSwitching() {
        $(document).on('click', '.character-journal-tab', function() {
            const targetTab = $(this).data('tab');
            
            // 切换标签激活状态
            $('.character-journal-tab').removeClass('active');
            $(this).addClass('active');
            
            // 切换内容显示
            $('.character-journal-tab-content').removeClass('active').hide();
            $(`.character-journal-tab-content[data-tab="${targetTab}"]`).addClass('active').show();
            
            // 保存当前标签状态
            localStorage.setItem('cj_current_tab', targetTab);
        });
        
        // 恢复上次打开的标签
        const lastTab = localStorage.getItem('cj_current_tab') || 'basic';
        $(`.character-journal-tab[data-tab="${lastTab}"]`).click();
    }

    // ========== 设置窗口控制 ==========
    function initModalControls() {
        // 打开设置窗口
        $(document).on('click', '#cj_open_settings', function() {
            $('#cj_settings_modal').fadeIn(300);
            initModalDragAndMinimize();
            
            // 同步主面板的状态显示到操作面板
            const mainStatus = $('#cj_status_display').html();
            $('#cj_status_display_modal').html(mainStatus);
        });
        
        // 关闭设置窗口（头部按钮）
        $(document).on('click', '#cj_close_settings', function() {
            $('#cj_settings_modal').fadeOut(300);
        });
        
        // 关闭设置窗口（底部按钮）
        $(document).on('click', '#cj_close_settings_footer', function() {
            $('#cj_settings_modal').fadeOut(300);
        });
        
        // 点击背景关闭
        $(document).on('click', '#cj_settings_modal', function(e) {
            if (e.target === this) {
                $(this).fadeOut(300);
            }
        });
        
        // 最小化按钮
        $(document).on('click', '#cj_minimize_settings', function() {
            const $modal = $('#cj_settings_modal');
            const $content = $('.character-journal-modal-content');
            
            if ($content.hasClass('minimized')) {
                // 恢复
                $content.removeClass('minimized');
                $modal.removeClass('minimized');
                $('#cj_minimize_settings span').text('−');
            } else {
                // 最小化
                $content.addClass('minimized');
                $modal.addClass('minimized');
                $('#cj_minimize_settings span').text('□');
            }
        });
        
        // 保存设置按钮
        $(document).on('click', '#cj_save_settings_modal', function() {
            // 触发原有的保存逻辑（在主index.js中定义）
            if (typeof window.characterJournal !== 'undefined' && 
                typeof window.characterJournal.saveSettings === 'function') {
                window.characterJournal.saveSettings();
                toastr.success('设置已保存');
            } else {
                console.warn('保存函数未找到');
                toastr.warning('保存功能暂不可用');
            }
        });
    }

    // ========== 窗口拖拽功能 ==========
    function initModalDragAndMinimize() {
        const $modal = $('.character-journal-modal-content');
        const $header = $('.character-journal-modal-header');
        
        let isDragging = false;
        let startX, startY, initialX, initialY;
        
        $header.on('mousedown', function(e) {
            // 如果点击的是按钮，不触发拖拽
            if ($(e.target).closest('.character-journal-modal-control-btn').length) {
                return;
            }
            
            isDragging = true;
            $modal.addClass('draggable');
            
            startX = e.clientX;
            startY = e.clientY;
            
            const rect = $modal[0].getBoundingClientRect();
            initialX = rect.left;
            initialY = rect.top;
            
            // 将modal设为absolute定位
            $modal.css({
                position: 'fixed',
                left: initialX + 'px',
                top: initialY + 'px',
                margin: 0
            });
            
            e.preventDefault();
        });
        
        $(document).on('mousemove', function(e) {
            if (!isDragging) return;
            
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            
            $modal.css({
                left: (initialX + deltaX) + 'px',
                top: (initialY + deltaY) + 'px'
            });
        });
        
        $(document).on('mouseup', function() {
            if (isDragging) {
                isDragging = false;
                $modal.removeClass('draggable');
            }
        });
    }

    // ========== 专用世界书字段显示/隐藏 ==========
    function initDedicatedWorldbookField() {
        $(document).on('change', '#cj_target', function() {
            if ($(this).val() === 'dedicated') {
                $('#cj_dedicated_worldbook_field').slideDown();
            } else {
                $('#cj_dedicated_worldbook_field').slideUp();
            }
        });
        
        // 初始化时检查
        if ($('#cj_target').val() === 'dedicated') {
            $('#cj_dedicated_worldbook_field').show();
        }
    }

    // ========== 选择现有世界书功能 ==========
    function initWorldbookSelector() {
        $(document).on('click', '#cj_select_worldbook', function() {
            // 获取所有世界书列表
            const worldInfos = window.SillyTavern?.getContext()?.world_info || [];
            
            if (worldInfos.length === 0) {
                toastr.info('当前没有可用的世界书');
                return;
            }
            
            // 创建选择列表
            let html = '<select id="cj_worldbook_selector" class="text_pole">';
            html += '<option value="">-- 选择世界书 --</option>';
            worldInfos.forEach(wb => {
                html += `<option value="${wb.name}">${wb.name}</option>`;
            });
            html += '</select>';
            
            // 显示对话框
            const popup = callPopup(html, 'text');
            popup.then((selectedName) => {
                if (selectedName) {
                    $('#cj_dedicated_worldbook').val(selectedName);
                }
            });
        });
    }

    // ========== 手动生成指定角色日志 ==========
    function initManualCharacterGeneration() {
        $(document).on('click', '#cj_generate_for_character', async function() {
            const characterName = $('#cj_manual_character_name').val().trim();
            const messageCount = parseInt($('#cj_manual_message_count').val());
            
            if (!characterName) {
                toastr.warning('请输入角色名称', '角色日志');
                return;
            }
            
            if (isNaN(messageCount) || messageCount < 5 || messageCount > 200) {
                toastr.error('消息数必须在5-200之间', '角色日志');
                return;
            }
            
            // 调用index.js中的函数
            if (typeof window.characterJournal !== 'undefined' && 
                typeof window.characterJournal.generateForSpecificCharacter === 'function') {
                await window.characterJournal.generateForSpecificCharacter();
            } else {
                console.error('[角色日志] 找不到generateForSpecificCharacter函数');
                toastr.error('功能暂不可用，请检查扩展加载状态', '角色日志');
            }
        });
    }

    // ========== 初始化所有功能 ==========
    function init() {
        console.log('[CharacterJournal] 初始化新布局处理器');
        
        // 等待DOM加载完成
        $(document).ready(function() {
            initTabSwitching();
            initModalControls();
            initDedicatedWorldbookField();
            initWorldbookSelector();
            initManualCharacterGeneration();
            
            console.log('[CharacterJournal] 新布局处理器初始化完成');
        });
    }

    // 自动初始化
    init();

    // 导出到全局，供其他模块调用
    window.characterJournalLayoutHandler = {
        initTabSwitching,
        initModalControls,
        initModalDragAndMinimize
    };

})();
